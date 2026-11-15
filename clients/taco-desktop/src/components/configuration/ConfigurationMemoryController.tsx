import { useEffect } from "react";
import { useConfigurationScope } from "../../hooks/useConfigurationScope";
import { useMemoryPane } from "../../hooks/useMemoryPane";
import { useT } from "../../i18n/useI18n";
import { subscribeMemoryChanged } from "../../lib/memoryEvents";
import { MemoryPane } from "../../views/MemoryPane";
import {
    type ConfigurationControllerProps,
    ConfigurationPageLayout,
} from "./ConfigurationPageLayout";

export interface ConfigurationMemoryControllerProps extends ConfigurationControllerProps {
    notify: (message: string) => void;
}

export function ConfigurationMemoryController(props: ConfigurationMemoryControllerProps) {
    const { active, client, notify } = props;
    const { t } = useT();
    const configuration = useConfigurationScope(props);
    const memory = useMemoryPane(client, active, configuration.targetCwd, t, notify);

    useEffect(
        () =>
            subscribeMemoryChanged((cwd) => {
                if (cwd === configuration.targetCwd) memory.loadMemory();
            }),
        [configuration.targetCwd, memory.loadMemory],
    );

    if (!active) return null;
    return (
        <ConfigurationPageLayout {...props} variant="target" configuration={configuration}>
            <MemoryPane
                data={memory.memoryData}
                loading={memory.memoryLoading}
                error={memory.memoryError}
                selectedId={memory.memorySelectedId}
                onSelect={memory.setMemorySelectedId}
                onSaveMemory={memory.handleSaveMemory}
                onDeleteTopic={memory.handleDeleteTopic}
                onRefresh={memory.loadMemory}
                saving={memory.memorySaving}
                target={configuration.targetCwd}
                dream={{
                    busy: memory.dreamBusy,
                    onRun: memory.handleDreamRun,
                    onApply: memory.handleDreamApply,
                    onDiscard: memory.handleDreamDiscard,
                    onUndo: memory.handleDreamUndo,
                    onRestoreTopic: memory.handleRestoreTopic,
                    onScheduleToggle: memory.handleDreamScheduleToggle,
                    dreamConfig: memory.dreamConfig,
                    onSaveConfig: memory.handleDreamConfigSave,
                }}
            />
        </ConfigurationPageLayout>
    );
}
