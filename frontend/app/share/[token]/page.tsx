import type { Metadata } from "next";
import { headers } from "next/headers";
import { shareMetadata } from "@/lib/shareMetadata";
import SharePageClient from "./SharePageClient";

interface Props {
    params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { token } = await params;
    return shareMetadata(token, await headers());
}

export default function SharePage() {
    return <SharePageClient />;
}
