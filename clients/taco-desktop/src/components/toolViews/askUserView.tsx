/**
 * askUser tool view — interactive card rendered inside the assistant's tools.
 *
 * Data flow: `tool.details.questions` (from `tool_execution_end.details`) holds the
 * question list. Single-choice clicks dispatch directly; multi-select accumulates
 * locally and the Submit button dispatches. `ASKUSER_ANSWERED` clears pending; the
 * useWorkspaces effect then calls `session.submitAnswers` to hand structured answers
 * to the sidecar. On history entry, `rehydrateAskUserDetails` back-fills
 * `toolResult.details` so the component renders answered state.
 */

import type { AskUserQuestion } from "@taco-ai/protocol";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { type AskUserAnswers, useAskUser } from "../../hooks/useAskUser";
import { type ToolViewProps, toolViews } from "./registry";

type AnswerValue = string | string[];

function isAnswer(v: AnswerValue | undefined): v is AnswerValue {
    if (v === undefined) return false;
    return typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
}

function normalizeAnswers(raw: unknown): AskUserAnswers {
    if (!raw || typeof raw !== "object") return {};
    const out: AskUserAnswers = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
        else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
    }
    return out;
}

export function AskUserToolView({ tool }: ToolViewProps) {
    const { answerAskUser, setAskUserAnswers } = useAskUser();

    const details = tool.details as
        | { questions?: AskUserQuestion[]; answers?: unknown; waiting?: boolean }
        | undefined;
    const questions: AskUserQuestion[] = details?.questions ?? [];
    // answered: any path that yields a non-empty details.answers (live or
    // history-rehydrated) enters the read-only echo state.
    const initialAnswers = normalizeAnswers(details?.answers);
    const answered = initialAnswers && Object.keys(initialAnswers).length > 0;

    // Local picked answers: accumulate while waiting; only the "Submit"
    // button dispatches. In the answered state we no longer use it (useState's
    // initial value still reads initialAnswers to keep the button state in sync).
    const [localAnswers, setLocalAnswers] = useState<AskUserAnswers>(() => initialAnswers);

    // Display source: answered state reads `details` directly (the authoritative
    // value, live or rehydrated; still effective if it arrives after mount).
    // Unanswered reads the local interactive state. This avoids a stale
    // useState initial value masking already-answered cards on history, and
    // skips the need for a useEffect state-sync.
    const displayAnswers: AskUserAnswers = answered ? initialAnswers : localAnswers;

    /** User clicks an option: only updates local + ref, never dispatches.
     *  In multi-question flows, users can flip choices freely. */
    function pickOption(next: AskUserAnswers) {
        setLocalAnswers(next);
        // Mirror into ref so it stays fresh even if the user never clicks
        // Submit; the Submit handler overwrites again to guarantee the
        // latest answers match the latest questions.
        setAskUserAnswers(tool.id, { answers: next, questions, toolName: tool.name });
    }

    /** User clicks Submit: dispatch ASKUSER_ANSWERED, clear pending, fire submitAnswers. */
    function submitAnswers() {
        answerAskUser(tool.id, localAnswers);
    }

    // Single-question / single-select: clicking an option submits directly
    // (no Submit button needed). Multi-question / multi-select: clicking only
    // updates local state; the bottom Submit button dispatches.
    const singleChoice = questions.length === 1 && questions[0]?.multiSelect !== true;

    /** Single-question / single-select only: click submits immediately,
     *  bypassing pickOption's ref path. */
    function pickAndSubmitSingleAnswer(question: string, label: string) {
        setAskUserAnswers(tool.id, {
            answers: { [question]: label },
            questions,
            toolName: tool.name,
        });
        answerAskUser(tool.id, { [question]: label });
    }

    function applySingleAnswer(question: string, label: string) {
        pickOption({ ...localAnswers, [question]: label });
    }

    function toggleMultiSelect(question: string, label: string) {
        const current = localAnswers[question];
        const prev: string[] = Array.isArray(current)
            ? current
            : typeof current === "string" && current
              ? [current]
              : [];
        const exists = prev.includes(label);
        const nextArr = exists ? prev.filter((l) => l !== label) : [...prev, label];
        pickOption({ ...localAnswers, [question]: nextArr });
    }

    // Submit button enabled once every question has a non-empty answer.
    const allAnswered =
        !answered &&
        questions.length > 0 &&
        questions.every((q) => {
            const a = localAnswers[q.question];
            if (a === undefined) return false;
            if (typeof a === "string") return a.length > 0;
            return a.length > 0;
        });

    if (questions.length === 0) {
        return (
            <div className="askuser-card">
                <p className="askuser-no-questions">Waiting for questions…</p>
            </div>
        );
    }

    return (
        <div className={`askuser-card${answered ? " answered" : ""}`}>
            {questions.map((q) => {
                const current = displayAnswers[q.question];
                const selected: string[] = Array.isArray(current)
                    ? current
                    : typeof current === "string" && current
                      ? [current]
                      : [];

                return (
                    <div key={q.question} className="askuser-question">
                        {q.header && <span className="askuser-header">{q.header}</span>}
                        <p className="askuser-text">{q.question}</p>
                        <div className="askuser-options">
                            {q.options.map((opt) => {
                                const isSelected = selected.includes(opt.label);
                                return (
                                    <button
                                        key={opt.label}
                                        type="button"
                                        // answered=true disables the buttons so a stale click can't re-dispatch
                                        // a commit. Suppressing click still allows keyboard focus to
                                        // surface the option's description.
                                        disabled={answered}
                                        className={`askuser-option${isSelected ? " selected" : ""}${answered ? " disabled" : ""}`}
                                        onClick={() => {
                                            if (answered) return;
                                            // Single-question / single-select: click submits directly, no Submit button.
                                            // Multi-question / multi-select: click only updates local state; the
                                            // bottom Submit button dispatches.
                                            if (singleChoice && q.multiSelect !== true) {
                                                pickAndSubmitSingleAnswer(q.question, opt.label);
                                            } else if (q.multiSelect) {
                                                toggleMultiSelect(q.question, opt.label);
                                            } else {
                                                applySingleAnswer(q.question, opt.label);
                                            }
                                        }}
                                        title={opt.description}
                                    >
                                        <div className="askuser-option-main">
                                            <span className="askuser-option-label">
                                                {opt.label}
                                            </span>
                                            <span className="askuser-option-desc">
                                                {opt.description}
                                            </span>
                                            {opt.preview && (
                                                <pre className="askuser-option-preview">
                                                    {opt.preview}
                                                </pre>
                                            )}
                                        </div>
                                        {isSelected && (
                                            <CheckCircle2
                                                size={12}
                                                className="askuser-check"
                                                aria-hidden="true"
                                            />
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                        {answered && isAnswer(current) && current.length > 0 && (
                            <p className="askuser-answer-note">
                                Selected:{" "}
                                {Array.isArray(current) ? `[${current.join(", ")}]` : current}
                            </p>
                        )}
                    </div>
                );
            })}
            {!answered && !singleChoice && questions.length > 0 && (
                <div className="askuser-submit-row">
                    <button
                        type="button"
                        className="askuser-submit"
                        disabled={!allAnswered}
                        onClick={submitAnswers}
                    >
                        提交
                    </button>
                </div>
            )}
        </div>
    );
}

toolViews.askUser = AskUserToolView;
