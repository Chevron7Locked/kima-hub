/**
 * Kima's own lint rules, for UI rulings that plain review keeps missing. Each message says what to do instead.
 */

const TOAST_IMPORT = /(^|\/)(sonner|notistack|react-toastify|[\w-]*toast(er|s)?)(\/|$)/i;
const TOAST_NAMES = new Set(["toast", "useToast", "Toaster"]);
const TOAST_FIX =
    "Kima has no toasts. Report an outcome with `notify` from @/lib/notify, which writes one row per title to the " +
    "notification tray, or show instant click feedback on the control itself.";

/** @type {import("eslint").Rule.RuleModule} */
const noToast = {
    meta: {
        type: "problem",
        docs: { description: "Feedback goes to the notification tray or the control, never a toast." },
        schema: [],
        messages: { toast: TOAST_FIX },
    },
    create(context) {
        const report = (node) => context.report({ node, messageId: "toast" });
        const checkSource = (node) => {
            if (typeof node.source?.value === "string" && TOAST_IMPORT.test(node.source.value)) report(node);
        };
        return {
            ImportDeclaration(node) {
                checkSource(node);
                if (TOAST_IMPORT.test(node.source.value)) return;
                for (const specifier of node.specifiers) {
                    if (specifier.imported && TOAST_NAMES.has(specifier.imported.name)) report(specifier);
                }
            },
            ImportExpression: checkSource,
            ExportNamedDeclaration: checkSource,
            ExportAllDeclaration: checkSource,
            CallExpression(node) {
                const { callee } = node;
                if (callee.type === "Identifier" && TOAST_NAMES.has(callee.name)) report(node);
                if (callee.type === "Identifier" && callee.name === "require") {
                    const [source] = node.arguments;
                    if (typeof source?.value === "string" && TOAST_IMPORT.test(source.value)) report(node);
                }
                if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return;
                if (callee.object.name === "toast") report(node);
                if (/^(window|globalThis)$/.test(callee.object.name) && callee.property.name === "toast") report(node);
            },
            JSXOpeningElement(node) {
                if (node.name.type === "JSXIdentifier" && /^Toast(er|Provider|Viewport|Root)?$/.test(node.name.name)) report(node);
            },
        };
    },
};

const CASE_CLASS = /(?:^|[\s:!])(uppercase|capitalize)!?(?=\s|$)|\[text-transform:(uppercase|capitalize)\]/;
const CASE_VALUE = /^(uppercase|capitalize)$/;
const CLASS_HELPERS = new Set(["cn", "clsx", "cx", "cva", "tv", "twJoin", "twMerge", "classNames"]);
const CLASS_METHODS = new Set(["cn", "clsx", "twMerge"]);
const CLASS_NAME = /^class(es|Name)?$|[a-z_]Class(es|Name)?$|[a-z_]Styles$/;
const COMPARISONS = new Set(["===", "!==", "==", "!="]);
const UPPERCASE_FIX =
    "Kima's UI is lowercase: `body` sets text-transform: lowercase and nothing capitalises. Remove `{{value}}`. For a " +
    "code, path or key that must keep its case, use the .font-mono or .t-data class. Text CSS cannot reach (tooltips, " +
    "<option>, page titles) is lowercased in the source.";

/** Whether a call's name says its arguments are class names. */
function isClassHelper(callee) {
    if (callee.type === "Identifier") return CLASS_HELPERS.has(callee.name);
    return callee.type === "MemberExpression" && CLASS_METHODS.has(callee.property.name);
}

/** Whether a string sits where its text is class names, not words a person reads or a value being compared. */
function holdsClassNames(node) {
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (parent.type === "BinaryExpression" && COMPARISONS.has(parent.operator)) return false;
        if (parent.type === "SwitchCase" && parent.test === child) return false;
        if (parent.type === "JSXAttribute") return CLASS_NAME.test(parent.name.name);
        if (parent.type === "CallExpression") return isClassHelper(parent.callee);
        if (parent.type === "FunctionDeclaration") return CLASS_NAME.test(parent.id?.name ?? "");
        if (parent.type === "VariableDeclarator") return parent.id.type === "Identifier" && CLASS_NAME.test(parent.id.name);
        if (parent.type === "Property" && parent.key.type === "Identifier" && CLASS_NAME.test(parent.key.name)) return true;
    }
    return false;
}

const VALUE_WRAPPERS = new Set(["ConditionalExpression", "LogicalExpression", "TemplateLiteral", "TSAsExpression", "TSSatisfiesExpression"]);

/** Whether a string is the value of a `textTransform` style, directly or through a condition. */
function isTextTransform(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === "Property") return (parent.key.name ?? parent.key.value) === "textTransform";
        if (parent.type === "AssignmentExpression") return parent.left.property?.name === "textTransform";
        if (!VALUE_WRAPPERS.has(parent.type)) return false;
    }
    return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const noUppercaseStyling = {
    meta: {
        type: "problem",
        docs: { description: "Nothing in the UI capitalises text." },
        schema: [],
        messages: { uppercase: UPPERCASE_FIX },
    },
    create(context) {
        const check = (node, text) => {
            if (typeof text !== "string") return;
            const inClasses = text.match(CASE_CLASS);
            if (inClasses && holdsClassNames(node)) {
                context.report({ node, messageId: "uppercase", data: { value: inClasses[0].trim() } });
            } else if (CASE_VALUE.test(text) && isTextTransform(node)) {
                context.report({ node, messageId: "uppercase", data: { value: `textTransform: ${text}` } });
            }
        };
        return {
            Literal: (node) => check(node, node.value),
            TemplateElement: (node) => check(node, node.value.cooked),
            Property(node) {
                if (!node.computed && node.key.type === "Identifier" && CASE_VALUE.test(node.key.name)) check(node.key, node.key.name);
            },
        };
    },
};

const kima = { rules: { "no-toast": noToast, "no-uppercase-styling": noUppercaseStyling } };

export default kima;
