﻿// Copyright (c) Microsoft. All rights reserved.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Orchestration;
using Microsoft.SemanticKernel.Planning;
using Microsoft.SemanticKernel.SkillDefinition;
using SemanticKernel.Service.CopilotChat.Models;
using SemanticKernel.Service.CopilotChat.Options;
using SemanticKernel.Service.CopilotChat.Skills.OpenApiPlugins.GitHubPlugin.Model;
using SemanticKernel.Service.CopilotChat.Skills.OpenApiPlugins.JiraPlugin.Model;

namespace SemanticKernel.Service.CopilotChat.Skills.ChatSkills;

/// <summary>
/// This skill provides the functions to acquire external information.
/// </summary>
public class ExternalInformationSkill
{
    /// <summary>
    /// Prompt settings.
    /// </summary>
    private readonly PromptsOptions _promptOptions;

    /// <summary>
    /// CopilotChat's planner to gather additional information for the chat context.
    /// </summary>
    private readonly CopilotChatPlanner _planner;

    /// <summary>
    /// Proposed plan to return for approval.
    /// </summary>
    public ProposedPlan? ProposedPlan { get; private set; }

    /// <summary>
    /// Preamble to add to the related information text.
    /// </summary>
    private const string PromptPreamble = "[RELATED START]";

    /// <summary>
    /// Header to indicate plan results.
    /// </summary>
    private const string ResultHeader = "RESULT: ";

    /// <summary>
    /// Postamble to add to the related information text.
    /// </summary>
    private const string PromptPostamble = "[RELATED END]";

    /// <summary>
    /// Create a new instance of ExternalInformationSkill.
    /// </summary>
    public ExternalInformationSkill(
        IOptions<PromptsOptions> promptOptions,
        CopilotChatPlanner planner)
    {
        this._promptOptions = promptOptions.Value;
        this._planner = planner;
    }

    /// <summary>
    /// Extract relevant additional knowledge using a planner.
    /// </summary>
    [SKFunction, Description("Acquire external information")]
    [SKParameter("tokenLimit", "Maximum number of tokens")]
    [SKParameter("proposedPlan", "Previously proposed plan that is approved")]
    public async Task<string> AcquireExternalInformationAsync(
        [Description("The intent to whether external information is needed")] string userIntent,
        SKContext context)
    {
        // TODO: [Issue #2106] Calculate planner and plan token usage
        FunctionsView functions = this._planner.Kernel.Skills.GetFunctionsView(true, true);
        if (functions.NativeFunctions.IsEmpty && functions.SemanticFunctions.IsEmpty)
        {
            return string.Empty;
        }

        // Check if plan exists in ask's context variables.
        var planExists = context.Variables.TryGetValue("proposedPlan", out string? proposedPlanJson);
        var deserializedPlan = planExists && !string.IsNullOrWhiteSpace(proposedPlanJson) ? JsonSerializer.Deserialize<ProposedPlan>(proposedPlanJson) : null;

        // Run plan if it was approved
        if (deserializedPlan != null && deserializedPlan.State == PlanState.Approved)
        {
            string planJson = JsonSerializer.Serialize(deserializedPlan.Plan);
            // Reload the plan with the planner's kernel so
            // it has full context to be executed
            var newPlanContext = new SKContext(null, this._planner.Kernel.Skills, this._planner.Kernel.Log);
            var plan = Plan.FromJson(planJson, newPlanContext);

            // Invoke plan
            newPlanContext = await plan.InvokeAsync(newPlanContext);
            var functionsUsed = $"FUNCTIONS EXECUTED: {string.Join("; ", this.GetPlanSteps(plan))}.";

            int tokenLimit =
                int.Parse(context["tokenLimit"], new NumberFormatInfo()) -
                TokenUtilities.TokenCount(PromptPreamble) -
                TokenUtilities.TokenCount(PromptPostamble) -
                TokenUtilities.TokenCount(functionsUsed) -
                TokenUtilities.TokenCount(ResultHeader);

            // The result of the plan may be from an OpenAPI skill. Attempt to extract JSON from the response.
            bool extractJsonFromOpenApi =
                this.TryExtractJsonFromOpenApiPlanResult(newPlanContext, newPlanContext.Result, out string planResult);
            if (extractJsonFromOpenApi)
            {
                planResult = this.OptimizeOpenApiSkillJson(planResult, tokenLimit, plan);
            }
            else
            {
                // If not, use result of the plan execution result directly.
                planResult = newPlanContext.Variables.Input;
            }

            return $"{PromptPreamble}\n{functionsUsed}\n{ResultHeader}{planResult.Trim()}\n{PromptPostamble}\n";
        }
        else
        {
            // Create a plan and set it in context for approval.
            var contextString = string.Join("\n", context.Variables.Where(v => v.Key != "userIntent").Select(v => $"{v.Key}: {v.Value}"));
            Plan? plan = null;
            // Use default planner options if planner options are null.
            var plannerOptions = this._planner.PlannerOptions ?? new PlannerOptions();
            int retriesAvail = plannerOptions.MissingFunctionError.AllowRetries
                ? plannerOptions.MissingFunctionError.MaxRetriesAllowed // Will always be at least 1
                : plannerOptions.AllowRetriesOnInvalidPlan ? 1 : 0;

            do
            { // TODO: [Issue #2256] Remove InvalidPlan retry logic once Core team stabilizes planner
                try
                {
                    plan = await this._planner.CreatePlanAsync($"Given the following context, accomplish the user intent.\nContext:\n{contextString}\nUser Intent:{userIntent}", context.Log);
                }
                catch (Exception e) when (this.IsRetriableError(e))
                {
                    if (retriesAvail > 0)
                    {
                        // PlanningExceptions are limited to one (1) pass as built-in stabilization. Retry limit of MissingFunctionErrors is user-configured.
                        retriesAvail = e is PlanningException ? 0 : retriesAvail--;

                        // Retry plan creation if LLM returned response that doesn't contain valid plan (invalid XML or JSON).
                        context.Log.LogWarning("Retrying CreatePlan on error: {0}", e.Message);
                        continue;
                    }
                    throw;
                }
            } while (plan == null);

            if (plan.Steps.Count > 0)
            {
                // Merge any variables from ask context into plan parameters as these will be used on plan execution.
                // These context variables come from user input, so they are prioritized.
                if (plannerOptions.Type == PlanType.Action)
                {
                    // Parameters stored in plan's top level state
                    this.MergeContextIntoPlan(context.Variables, plan.Parameters);
                }
                else
                {
                    foreach (var step in plan.Steps)
                    {
                        this.MergeContextIntoPlan(context.Variables, step.Parameters);
                    }
                }

                this.ProposedPlan = new ProposedPlan(plan, plannerOptions.Type, PlanState.NoOp);
            }
        }

        return string.Empty;
    }

    #region Private

    /// <summary>
    /// Retry on plan creation error if:
    /// 1. PlannerOptions.AllowRetriesOnInvalidPlan is true and exception contains error code InvalidPlan.
    /// 2. PlannerOptions.MissingFunctionError.AllowRetries is true and exception contains error code FunctionNotAvailable.
    /// </summary>
    private bool IsRetriableError(Exception e)
    {
        var retryOnInvalidPlanError = e is PlanningException
            && ((e as PlanningException)!.ErrorCode == PlanningException.ErrorCodes.InvalidPlan
                || (e.InnerException as PlanningException)!.ErrorCode == PlanningException.ErrorCodes.InvalidPlan)
            && this._planner.PlannerOptions!.AllowRetriesOnInvalidPlan;

        var retryOnMissingFunctionError = e is KernelException
            && (e as KernelException)!.ErrorCode == KernelException.ErrorCodes.FunctionNotAvailable
            && this._planner.PlannerOptions!.MissingFunctionError.AllowRetries;

        return retryOnMissingFunctionError || retryOnInvalidPlanError;
    }

    /// <summary>
    /// Merge any variables from context into plan parameters.
    /// </summary>
    private void MergeContextIntoPlan(ContextVariables variables, ContextVariables planParams)
    {
        foreach (var param in planParams)
        {
            if (param.Key.Equals("INPUT", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (variables.TryGetValue(param.Key, out string? value))
            {
                planParams.Set(param.Key, value);
            }
        }
    }

    /// <summary>
    /// Try to extract json from the planner response as if it were from an OpenAPI skill.
    /// </summary>
    private bool TryExtractJsonFromOpenApiPlanResult(SKContext context, string openApiSkillResponse, out string json)
    {
        try
        {
            JsonNode? jsonNode = JsonNode.Parse(openApiSkillResponse);
            string contentType = jsonNode?["contentType"]?.ToString() ?? string.Empty;
            if (contentType.StartsWith("application/json", StringComparison.InvariantCultureIgnoreCase))
            {
                var content = jsonNode?["content"]?.ToString() ?? string.Empty;
                if (!string.IsNullOrWhiteSpace(content))
                {
                    json = content;
                    return true;
                }
            }
        }
        catch (JsonException)
        {
            context.Log.LogDebug("Unable to extract JSON from planner response, it is likely not from an OpenAPI skill.");
        }
        catch (InvalidOperationException)
        {
            context.Log.LogDebug("Unable to extract JSON from planner response, it may already be proper JSON.");
        }

        json = string.Empty;
        return false;
    }

    /// <summary>
    /// Try to optimize json from the planner response
    /// based on token limit
    /// </summary>
    private string OptimizeOpenApiSkillJson(string jsonContent, int tokenLimit, Plan plan)
    {
        // Remove all new line characters + leading and trailing white space
        jsonContent = Regex.Replace(jsonContent.Trim(), @"[\n\r]", string.Empty);
        var document = JsonDocument.Parse(jsonContent);
        string lastSkillInvoked = plan.Steps[^1].SkillName;
        string lastSkillFunctionInvoked = plan.Steps[^1].Name;
        bool trimSkillResponse = false;

        // The json will be deserialized based on the response type of the particular operation that was last invoked by the planner
        // The response type can be a custom trimmed down json structure, which is useful in staying within the token limit
        Type skillResponseType = this.GetOpenApiSkillResponseType(ref document, ref lastSkillInvoked, ref lastSkillFunctionInvoked, ref trimSkillResponse);

        if (trimSkillResponse)
        {
            // Deserializing limits the json content to only the fields defined in the respective OpenApiSkill's Model classes
            var skillResponse = JsonSerializer.Deserialize(jsonContent, skillResponseType);
            jsonContent = skillResponse != null ? JsonSerializer.Serialize(skillResponse) : string.Empty;
            document = JsonDocument.Parse(jsonContent);
        }

        int jsonContentTokenCount = TokenUtilities.TokenCount(jsonContent);

        // Return the JSON content if it does not exceed the token limit
        if (jsonContentTokenCount < tokenLimit)
        {
            return jsonContent;
        }

        List<object> itemList = new();

        // Some APIs will return a JSON response with one property key representing an embedded answer.
        // Extract this value for further processing
        string resultsDescriptor = "";

        if (document.RootElement.ValueKind == JsonValueKind.Object)
        {
            int propertyCount = 0;
            foreach (JsonProperty property in document.RootElement.EnumerateObject())
            {
                propertyCount++;
            }

            if (propertyCount == 1)
            {
                // Save property name for result interpolation
                JsonProperty firstProperty = document.RootElement.EnumerateObject().First();
                tokenLimit -= TokenUtilities.TokenCount(firstProperty.Name);
                resultsDescriptor = string.Format(CultureInfo.InvariantCulture, "{0}: ", firstProperty.Name);

                // Extract object to be truncated
                JsonElement value = firstProperty.Value;
                document = JsonDocument.Parse(value.GetRawText());
            }
        }

        // Detail Object
        // To stay within token limits, attempt to truncate the list of properties
        if (document.RootElement.ValueKind == JsonValueKind.Object)
        {
            foreach (JsonProperty property in document.RootElement.EnumerateObject())
            {
                int propertyTokenCount = TokenUtilities.TokenCount(property.ToString());

                if (tokenLimit - propertyTokenCount > 0)
                {
                    itemList.Add(property);
                    tokenLimit -= propertyTokenCount;
                }
                else
                {
                    break;
                }
            }
        }

        // Summary (List) Object
        // To stay within token limits, attempt to truncate the list of results
        if (document.RootElement.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in document.RootElement.EnumerateArray())
            {
                int itemTokenCount = TokenUtilities.TokenCount(item.ToString());

                if (tokenLimit - itemTokenCount > 0)
                {
                    itemList.Add(item);
                    tokenLimit -= itemTokenCount;
                }
                else
                {
                    break;
                }
            }
        }

        return itemList.Count > 0
            ? string.Format(CultureInfo.InvariantCulture, "{0}{1}", resultsDescriptor, JsonSerializer.Serialize(itemList))
            : string.Format(CultureInfo.InvariantCulture, "JSON response from {0} is too large to be consumed at this time.", this._planner.PlannerOptions?.Type == PlanType.Sequential ? "plan" : lastSkillInvoked);
    }

    private Type GetOpenApiSkillResponseType(ref JsonDocument document, ref string lastSkillInvoked, ref string lastSkillFunctionInvoked, ref bool trimSkillResponse)
    {
        // TODO: [Issue #93] Find a way to determine response type if multiple steps are invoked
        Type skillResponseType = typeof(object); // Use a reasonable default response type

        // Different operations under the skill will return responses as json structures;
        // Prune each operation response according to the most important/contextual fields only to avoid going over the token limit
        // Check what the last skill invoked was and deserialize the JSON content accordingly
        if (string.Equals(lastSkillInvoked, "GitHubPlugin", StringComparison.Ordinal))
        {
            trimSkillResponse = true;
            skillResponseType = this.GetGithubSkillResponseType(ref document);
        }
        else if (string.Equals(lastSkillInvoked, "JiraPlugin", StringComparison.Ordinal))
        {
            trimSkillResponse = true;
            skillResponseType = this.GetJiraPluginResponseType(ref document, ref lastSkillFunctionInvoked);
        }

        return skillResponseType;
    }

    private Type GetGithubSkillResponseType(ref JsonDocument document)
    {
        return document.RootElement.ValueKind == JsonValueKind.Array ? typeof(PullRequest[]) : typeof(PullRequest);
    }

    private Type GetJiraPluginResponseType(ref JsonDocument document, ref string lastSkillFunctionInvoked)
    {
        if (lastSkillFunctionInvoked == "GetIssue")
        {
            return document.RootElement.ValueKind == JsonValueKind.Array ? typeof(IssueResponse[]) : typeof(IssueResponse);
        }

        return typeof(IssueResponse);
    }

    /// <summary>
    /// Retrieves the steps in a plan that was executed successfully.
    /// </summary>
    /// <param name="plan">The plan object.</param>
    /// <returns>A list of strings representing the successfully executed steps in the plan.</returns>
    private List<string> GetPlanSteps(Plan plan)
    {
        List<string> steps = new();
        foreach (var step in plan.Steps)
        {
            steps.Add($"{step.SkillName}.{step.Name}");
        }

        return steps;
    }

    #endregion
}
