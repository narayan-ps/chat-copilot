// Copyright (c) Microsoft. All rights reserved.

import { AuthenticatedTemplate, UnauthenticatedTemplate, useIsAuthenticated, useMsal } from '@azure/msal-react';
import { FluentProvider, Subtitle1, makeStyles, shorthands, tokens } from '@fluentui/react-components';

import * as React from 'react';
import { FC, useEffect } from 'react';
import { UserSettingsMenu } from './components/header/UserSettingsMenu';
import { PluginGallery } from './components/open-api-plugins/PluginGallery';
import BackendProbe from './components/views/BackendProbe';
import { ChatView } from './components/views/ChatView';
import Loading from './components/views/Loading';
import { Login } from './components/views/Login';
import { useChat } from './libs/hooks';
import { AlertType } from './libs/models/AlertType';
import { useAppDispatch, useAppSelector } from './redux/app/hooks';
import { RootState } from './redux/app/store';
import { FeatureKeys } from './redux/features/app/AppState';
import { addAlert, setActiveUserInfo, setServiceOptions } from './redux/features/app/appSlice';
import { semanticKernelDarkTheme, semanticKernelLightTheme } from './styles';

export const useClasses = makeStyles({
    container: {
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100%',
        ...shorthands.overflow('hidden'),
    },
    header: {
        alignItems: 'center',
        backgroundColor: tokens.colorBrandForeground2,
        color: tokens.colorNeutralForegroundOnBrand,
        display: 'flex',
        '& h1': {
            paddingLeft: tokens.spacingHorizontalXL,
            display: 'flex',
        },
        height: '48px',
        justifyContent: 'space-between',
        width: '100%',
    },
    persona: {
        marginRight: tokens.spacingHorizontalXXL,
    },
    cornerItems: {
        display: 'flex',
        ...shorthands.gap(tokens.spacingHorizontalS),
    },
});

enum AppState {
    ProbeForBackend,
    LoadingChats,
    Chat,
    SigningOut,
}

const App: FC = () => {
    const classes = useClasses();

    const [appState, setAppState] = React.useState(AppState.ProbeForBackend);
    const dispatch = useAppDispatch();

    const { instance, inProgress } = useMsal();
    const { activeUserInfo, features } = useAppSelector((state: RootState) => state.app);
    const isAuthenticated = useIsAuthenticated();

    const chat = useChat();

    useEffect(() => {
        if (isAuthenticated) {
            let isActiveUserInfoSet = activeUserInfo !== undefined;
            if (!isActiveUserInfoSet) {
                const account = instance.getActiveAccount();
                if (!account) {
                    dispatch(addAlert({ type: AlertType.Error, message: 'Unable to get active logged in account.' }));
                } else {
                    dispatch(
                        setActiveUserInfo({
                            id: account.homeAccountId,
                            email: account.username, // username in an AccountInfo object is the email address
                            username: account.name ?? account.username,
                        }),
                    );
                }
                isActiveUserInfoSet = true;
            }

            if (appState === AppState.LoadingChats) {
                void Promise.all([
                    // Load all chats from memory
                    chat.loadChats().then((succeeded) => {
                        if (succeeded) {
                            setAppState(AppState.Chat);
                        }
                    }),

                    // Load service options
                    chat.getServiceOptions().then((serviceOptions) => {
                        if (serviceOptions) {
                            dispatch(setServiceOptions(serviceOptions));
                        }
                    }),
                ]);
            }
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [instance, inProgress, isAuthenticated, appState]);

    // TODO: [Issue #41] handle error case of missing account information
    return (
        <FluentProvider
            className="app-container"
            theme={features[FeatureKeys.DarkMode].enabled ? semanticKernelDarkTheme : semanticKernelLightTheme}
        >
            <UnauthenticatedTemplate>
                <div className={classes.container}>
                    <div className={classes.header}>
                        <Subtitle1 as="h1">Chat Copilot</Subtitle1>
                    </div>
                    {appState === AppState.SigningOut && <Loading text="Signing you out..." />}
                    {appState !== AppState.SigningOut && <Login />}
                </div>
            </UnauthenticatedTemplate>
            <AuthenticatedTemplate>
                <div className={classes.container}>
                    <div className={classes.header}>
                        <Subtitle1 as="h1">Chat Copilot</Subtitle1>
                        <div className={classes.cornerItems}>
                            <div data-testid="logOutMenuList" className={classes.cornerItems}>
                                <PluginGallery />
                                <UserSettingsMenu
                                    setLoadingState={() => {
                                        setAppState(AppState.SigningOut);
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                    {appState === AppState.ProbeForBackend && (
                        <BackendProbe
                            uri={process.env.REACT_APP_BACKEND_URI as string}
                            onBackendFound={() => {
                                setAppState(AppState.LoadingChats);
                            }}
                        />
                    )}
                    {appState === AppState.LoadingChats && <Loading text="Loading Chats..." />}
                    {appState === AppState.Chat && <ChatView />}
                </div>
            </AuthenticatedTemplate>
        </FluentProvider>
    );
};

export default App;
