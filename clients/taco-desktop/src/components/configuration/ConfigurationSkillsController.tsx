import { useConfigurationScope } from "../../hooks/useConfigurationScope";
import { useSkillsPane } from "../../hooks/useSkillsPane";
import { SkillsPane } from "../../views/SkillsPane";
import {
    type ConfigurationControllerProps,
    ConfigurationPageLayout,
} from "./ConfigurationPageLayout";

export function ConfigurationSkillsController(props: ConfigurationControllerProps) {
    const { active, client } = props;
    const configuration = useConfigurationScope(props);
    const skills = useSkillsPane(client, active, configuration.targetCwd, configuration.scope);

    if (!active) return null;
    return (
        <ConfigurationPageLayout {...props} variant="catalog" configuration={configuration}>
            <SkillsPane
                skills={skills.skills}
                totalCount={skills.totalCount}
                skillsError={skills.skillsError}
                query={skills.query}
                onQueryChange={skills.setQuery}
                diagnostics={skills.diagnostics}
                selectedName={skills.selectedSkillName ?? skills.skills[0]?.name ?? null}
                onSelect={skills.setSelectedSkillName}
                content={skills.skillContent}
                contentLoading={skills.skillContentLoading}
                contentError={skills.skillContentError}
            />
        </ConfigurationPageLayout>
    );
}
