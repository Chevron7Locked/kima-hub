"use client";

import React, { Component, ReactNode } from "react";

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

/**
 * Global error boundary for catching application-level errors.
 * Provides a fallback UI when critical errors occur in production.
 */
export class GlobalErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error("[GlobalErrorBoundary] Application error:", error);
        console.error(
            "[GlobalErrorBoundary] Component stack:",
            errorInfo.componentStack
        );
    }

    private handleReload = () => {
        window.location.reload();
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white p-4">
                    <div className="max-w-md w-full text-center space-y-6">
                        <div className="space-y-2">
                            <h1 className="text-2xl font-bold">
                                Something went wrong
                            </h1>
                            <p className="text-gray-400">
                                An unexpected error occurred. Please try
                                reloading the page.
                            </p>
                        </div>
                        {this.state.error && (
                            <div className="bg-gray-900 p-4 rounded-lg text-left">
                                <p className="text-sm font-mono text-red-400 break-words">
                                    {this.state.error.message}
                                </p>
                            </div>
                        )}
                        <button
                            onClick={this.handleReload}
                            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors"
                        >
                            Reload Page
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
