﻿// Copyright (c) Microsoft. All rights reserved.

using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;

namespace SemanticKernel.Service.CopilotChat.Models;

public class ServiceOptionsResponse
{
    /// <summary>
    /// Response to memoriesStoreType request.
    /// </summary>
    public class MemoriesStoreOptionResponse
    {
        /// <summary>
        /// All the available memories store types.
        /// </summary>
        [JsonPropertyName("types")]
        public IEnumerable<string> Types { get; set; } = Enumerable.Empty<string>();

        /// <summary>
        /// The selected memories store type.
        /// </summary>
        [JsonPropertyName("selectedType")]
        public string SelectedType { get; set; } = string.Empty;
    }

    /// <summary>
    /// The memories store that is configured.
    /// </summary>
    [JsonPropertyName("memoriesStore")]
    public MemoriesStoreOptionResponse MemoriesStore { get; set; } = new MemoriesStoreOptionResponse();
}

