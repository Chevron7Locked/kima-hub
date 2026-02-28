"use client";

import { createContext, useContext, useEffect, useState, useMemo, ReactNode } from "react";
import { api } from "./api";

interface FeaturesState {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    loading: boolean;
}

const defaultState: FeaturesState = {
    musicCNN: false,
    vibeEmbeddings: false,
    loading: true,
};

const FeaturesContext = createContext<FeaturesState | undefined>(undefined);

export function FeaturesProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<FeaturesState>(defaultState);

    useEffect(() => {
        const fetchFeatures = () => {
            api.getFeatures()
                .then((features) => {
                    setState({
                        musicCNN: features.musicCNN,
                        vibeEmbeddings: features.vibeEmbeddings,
                        loading: false,
                    });
                })
                .catch((error) => {
                    console.error("Failed to fetch features:", error);
                    setState((prev) => ({ ...prev, loading: false }));
                });
        };

        fetchFeatures();
        const interval = setInterval(fetchFeatures, 60000);
        return () => clearInterval(interval);
    }, []);

    const value = useMemo(() => state, [state]);

    return (
        <FeaturesContext.Provider value={value}>
            {children}
        </FeaturesContext.Provider>
    );
}

export function useFeatures(): FeaturesState {
    const context = useContext(FeaturesContext);
    if (!context) {
        throw new Error("useFeatures must be used within FeaturesProvider");
    }
    return context;
}
