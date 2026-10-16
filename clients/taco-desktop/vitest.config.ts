import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "happy-dom",
        // Component tests mount real markdown/shiki pipelines and Radix portals,
        // and vitest runs the 36 files in parallel — a loaded box needs more
        // than the 5s default before a legitimate render is called a hang.
        testTimeout: 15000,
        // Only runs hooks/ and components/ .test.tsx — other .test.ts go through the
        // `pnpm test` tsx --test path. Pure function + reducer unit tests use node:test;
        // React component tests use vitest.
        include: [
            "tests/hooks/useRetryOnError.test.tsx",
            "tests/hooks/useFileTree.test.tsx",
            "tests/hooks/useFilePreview.test.tsx",
            "tests/hooks/useImPolicy.test.tsx",
            "tests/hooks/useWorkspacesSteer.test.tsx",
            "tests/hooks/useWorkspacesAttach.test.tsx",
            "tests/hooks/useWorkspacesNotifications.test.tsx",
            "tests/hooks/useWorkspacesDefaultCwdSettled.test.tsx",
            "tests/hooks/useSaveConfigPatch.test.tsx",
            "tests/hooks/useDragResize.test.tsx",
            "tests/hooks/useRightPanel.test.tsx",
            "tests/hooks/useStickToBottom.test.tsx",
            "tests/hooks/useRightPanelAutoOpen.test.tsx",
            "tests/components/AssistantMarkdown.test.tsx",
            "tests/components/FilesDrawer.test.tsx",
            "tests/components/FilePreviewGrant.test.tsx",
            "tests/components/MemoryPane.test.tsx",
            "tests/components/Sidebar.test.tsx",
            "tests/components/SubagentPanel.test.tsx",
            "tests/components/AgentForm.test.tsx",
            "tests/components/AgentsPane.test.tsx",
            "tests/components/ImPolicyDialog.test.tsx",
            "tests/components/ContextIndicator.test.tsx",
            "tests/components/TopbarQuickActions.test.tsx",
            "tests/components/NotificationBell.test.tsx",
            "tests/components/LlmDumpPanel.test.tsx",
            "tests/components/toolViews/ReadToolCard.test.tsx",
            "tests/components/toolViews/ToolCardShell.test.tsx",
            "tests/components/ui/Switch.test.tsx",
            "tests/components/ui/TextInput.test.tsx",
            "tests/components/ui/Select.test.tsx",
            "tests/components/ui/Slider.test.tsx",
            "tests/components/ui/Modal.test.tsx",
            "tests/components/settings/ProviderDetailModal.test.tsx",
            "tests/components/settings/ProviderSection.test.tsx",
            "tests/components/settings/McpSection.test.tsx",
            "tests/components/settings/PermissionsTab.test.tsx",
            "tests/components/settings/SchedulesTab.test.tsx",
        ],
    },
});
