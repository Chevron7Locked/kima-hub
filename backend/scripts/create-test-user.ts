import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
    const username = process.env.LIDIFY_TEST_USERNAME || "predeploy";
    const password = process.env.LIDIFY_TEST_PASSWORD || "predeploy-password";

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.upsert({
        where: { username },
        update: { password: hashedPassword },
        create: {
            username,
            password: hashedPassword,
            onboardingComplete: true,
        },
    });

    console.log(`Test user ready: ${user.username}`);
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
