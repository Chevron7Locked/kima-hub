"use client";

import { PageHeader } from "@/components/layout/PageHeader";

const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
};

export function HomeHero() {
    const greeting = getGreeting();

    return <PageHeader title={greeting} description="Your library at a glance" />;
}
