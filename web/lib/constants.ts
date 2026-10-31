export const RESPONSE_MODES = [
  { id: 'quick', label: 'Quick', description: 'Short, immediate answer' },
  { id: 'professional', label: 'Professional', description: 'Concise, contextual answer' },
  { id: 'technical', label: 'Technical', description: 'Structured technical explanation' },
  { id: 'star', label: 'STAR', description: 'Behavioral story structure' },
  { id: 'detailed', label: 'Detailed', description: 'Expanded explanation' }
] as const;
export const RESPONSE_MODE_IDS = RESPONSE_MODES.map((m) => m.id) as unknown as [string, ...string[]];

export const INTERVIEW_TYPES = [
  { id: 'general', label: 'General' },
  { id: 'technical', label: 'Technical' },
  { id: 'behavioral', label: 'Behavioral' },
  { id: 'system-design', label: 'System design' },
  { id: 'hr', label: 'HR / screening' }
] as const;
export const INTERVIEW_TYPE_IDS = INTERVIEW_TYPES.map((t) => t.id) as unknown as [string, ...string[]];
