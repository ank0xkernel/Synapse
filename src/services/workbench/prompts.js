'use strict';

// Prompts for the workbench stages. Each asks for one JSON object whose shape
// contracts.js validates; nothing the model returns is used unchecked.

const EVIDENCE_RULE = 'Use only what the screen text, the request and the project files below show. Never invent file paths, code, command output or test results. When something needed is not shown, list it under "missing" or "uncertainties".';

function understandPrompt({ request, screenText, projectName }) {
  return `You turn a user's request, plus what is on their screen, into a structured task description.
${EVIDENCE_RULE}

=== USER REQUEST ===
${request || '(none: the user wants the task that is on screen)'}

=== SCREEN (text read from the user's screen; may contain OCR errors; may be empty) ===
${screenText || '(no screen text available)'}

=== ACTIVE PROJECT ===
${projectName ? `A project folder named "${projectName}" is open in Synapse.` : 'No project is open.'}

Reply with ONE JSON object and nothing else:
{
  "kind": "question" | "coding_problem" | "math" | "project_change" | "debugging" | "explanation",
  "title": "short title",
  "statement": "the complete task in your own words, using every relevant detail from the screen and the request",
  "requirements": ["..."], "constraints": ["..."], "examples": ["input -> output, copied from the screen"],
  "inputFormat": "", "outputFormat": "",
  "language": "programming language required, or null",
  "needsProject": true when answering requires reading or changing files in the project, else false,
  "missing": ["information the task needs that is not visible or not readable"],
  "subtasks": ["separate questions or parts, if more than one"],
  "evidence": "screen" | "user" | "both"
}
Rules: "project_change" and "debugging" of the user's own code set needsProject true. A standalone algorithm, maths or general question sets needsProject false, even when a project is open. If several unrelated questions are visible and the request does not pick one, describe the most prominent one and list the others in "subtasks".`;
}

function planPrompt({ task, request, projectSummary, files, outlines, failures }) {
  const fileBlocks = files.map((f) => `--- FILE ${f.path} (${f.lines} lines) ---\n${f.numbered}`).join('\n\n');
  return `You plan a change to a software project. A separate system applies your edits exactly and runs your commands only after the user approves each one.
${EVIDENCE_RULE}

=== TASK ===
${JSON.stringify(task, null, 2)}

=== USER REQUEST ===
${request}

=== PROJECT ===
${projectSummary}

=== RELEVANT FILES (line-numbered; the numbers are not part of the file) ===
${fileBlocks || '(none found)'}

=== OTHER FILES AND THEIR SYMBOLS ===
${outlines || '(none)'}
${failures ? `\n=== PREVIOUS ATTEMPT FAILED (real command output) ===\n${failures}\n` : ''}
Reply with ONE JSON object and nothing else:
{
  "summary": "one paragraph: what you will change and why",
  "approach": "the technical design, algorithm and its time/space complexity when relevant",
  "files": [{ "path": "repo-relative path", "reason": "why it matters", "symbols": ["functions or classes involved"] }],
  "edits": [
    { "path": "repo-relative path", "kind": "replace", "search": "exact text copied from the file above, long enough to occur exactly once", "replace": "the new text", "reason": "...", "symbols": ["..."] },
    { "path": "new/file/path.ext", "kind": "create", "content": "full file content", "reason": "why a new file is needed" }
  ],
  "commands": [{ "command": "shell command", "cwd": "repo-relative directory, '.' for the root", "purpose": "what it checks", "kind": "validation" | "setup" | "other" }],
  "validation": ["how the result will be checked"],
  "uncertainties": ["assumptions and anything you could not confirm"]
}
Rules:
- "search" must be copied character for character from a file shown above, without the line numbers, and must be unique in that file. Keep each edit small; use several edits rather than one huge one.
- Only edit files shown above or create new ones. Never delete files unless the task explicitly asks.
- Preserve existing behaviour that the task does not ask to change. Follow the project's existing style.
- Validation commands must use the project's own scripts and tools listed under PROJECT (for example its test or build script). Do not install packages unless the task requires it, and then say so in "uncertainties".
- If the information is not enough to make a safe change, return no edits and explain in "uncertainties".`;
}

function answerPrompt({ task, request, screenText, plan, actions, projectName }) {
  const actionLines = (actions || []).map((a) => (a.type === 'edit'
    ? `- edit ${a.path} (${a.editKind}): ${a.status}${a.result && a.result.error ? ` (${a.result.error.code}: ${a.result.error.message})` : ''}${a.valid === false ? ` [invalid: ${a.invalidReason}]` : ''}`
    : `- command \`${a.command}\` in ${a.cwd}: ${a.status}${a.result && Number.isInteger(a.result.exitCode) ? `, exit ${a.result.exitCode}` : ''}${a.result && a.result.timedOut ? ', timed out' : ''}${a.result && (a.result.stdout || a.result.stderr) ? `\n  output (tail):\n${String(`${a.result.stdout || ''}\n${a.result.stderr || ''}`).trim().split('\n').slice(-25).map((l) => `    ${l}`).join('\n')}` : ''}`)).join('\n');
  return `You write the final answer for the user. Be direct and technically precise, in Markdown.
${EVIDENCE_RULE}

=== TASK ===
${JSON.stringify(task, null, 2)}

=== USER REQUEST ===
${request || '(the task on screen)'}

${screenText ? `=== SCREEN TEXT ===\n${screenText}\n` : ''}${projectName ? `=== PROJECT ===\n${projectName}\n` : ''}${plan ? `=== PLAN ===\n${plan.summary}\n${plan.approach}\nUncertainties: ${(plan.uncertainties || []).join('; ') || 'none'}\n` : ''}${actionLines ? `=== WHAT ACTUALLY HAPPENED (from Synapse's own records) ===\n${actionLines}\n` : ''}
Rules:
- Statuses mean exactly: suggested = only proposed; rejected = the user declined; executed/Ran = applied or run; verified = a check Synapse ran passed; failed = it ran and failed. Never say something was changed, run, tested or passed unless the record above says so.
- For coding problems: approach, complete code in the required language, time and space complexity, edge cases. Code that was not executed is your reasoning; say so when you present expected outputs.
- For project work: list each changed file by its exact path and what changed; report command results from the record; if something failed, explain the real error from its output and the likely fix.
- If information was missing, say what and how it limits the answer.`;
}

module.exports = { understandPrompt, planPrompt, answerPrompt };
