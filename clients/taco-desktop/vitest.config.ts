import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "happy-dom",
        // Only runs hooks/ and components/ .test.tsx — other .test.ts go through the
        // `pnpm test` tsx --test path. Pure function + reducer unit tests use node:test;
        // React component tests use vitest.
        include: [
            "tests/hooks/useRetryOnError.test.tsx",
            "tests/hooks/useFileTree.test.tsx",
            "tests/hooks/useFilePreview.test.tsx",
            "tests/hooks/useImPolicy.test.tsx",
            "tests/hooks/useSaveConfigPatch.test.tsx",
            "tests/components/FilesDrawer.test.tsx",
            "tests/components/MemoryPane.test.tsx",
            "tests/components/ImPolicyDialog.test.tsx",
            "tests/components/ui/Switch.test.tsx",
            "tests/components/ui/TextInput.test.tsx",
            "tests/components/ui/Select.test.tsx",
            "tests/components/ui/Slider.test.tsx",
            "tests/components/settings/CustomProviderForm.test.tsx",
            "tests/components/settings/McpSection.test.tsx",
            "tests/components/settings/PermissionsTab.test.tsx",
        ],
    },
});
