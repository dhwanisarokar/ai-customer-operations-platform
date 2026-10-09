/**
 * Display title of a web chat conversation, derived (deterministically) from its subject, which the
 * server fills with the visitor's first message. A chat list that shows the same sentence as title AND
 * preview is noise, so the title is the topic ("Refund policy") and the preview stays the message.
 * No database field is involved: this is presentation only.
 */

const GREETING =
  /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|dear (?:team|support))\b[\s,!.:-]*/i;

/** Leading filler that introduces a question without being the topic. Applied repeatedly. */
const LEADING_FILLER: RegExp[] = [
  /^(?:please|kindly)\b[\s,]*/i,
  /^(?:can|could|would|will) (?:you|u) (?:please |kindly )?(?:tell|explain|show|give|send|share|help)(?: me)?(?: with| about| on)?\b\s*/i,
  /^(?:i(?:'d| would) like|i want|i need|i wanna) (?:to )?(?:know|ask|understand|learn|get|see|find out)(?: more)?(?: about| on| how)?\b\s*/i,
  /^(?:i(?:'d| would) like|i want|i need|i wanna)(?: some)?(?: help)? (?:with|about|regarding)\b\s*/i,
  /^(?:i have|i've got|i got) (?:a )?(?:question|questions|problem|issue)(?: about| with| regarding)?\b\s*/i,
  /^(?:what(?:'s| is| are)|whats|where(?:'s| is| are)|how (?:do|can|does|should) (?:i|you|we)|how (?:is|are)|do you (?:have|offer)|is there|are there)\b\s*/i,
  /^(?:your|the|our|a|an|any|some|more|info|information|details)\b\s*/i,
  /^(?:about|regarding|on|for|with)\b\s*/i,
];

const MAX_TITLE = 48;

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clean(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[?!.…,;:\s]+$/g, "")
    .trim();
}

/** "can you tell me about refund policy?" -> "Refund policy". Falls back to the subject itself. */
export function conversationTitle(subject: string): string {
  const original = clean(subject);
  if (!original) return "New conversation";

  let topic = original.replace(GREETING, "");
  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false;
    for (const filler of LEADING_FILLER) {
      const next = topic.replace(filler, "");
      if (next !== topic) {
        topic = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  topic = clean(topic);

  // Nothing meaningful left (e.g. "hello"): keep a short version of what they wrote.
  if (topic.length < 3) topic = original;
  if (topic.length > MAX_TITLE) {
    const cut = topic.slice(0, MAX_TITLE - 1);
    topic = `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : cut.length)}…`;
  }
  return sentenceCase(topic);
}

const normalize = (text: string) => clean(text).toLowerCase();

/** True when showing `preview` under `title` would just repeat the same words. */
export function repeatsTitle(title: string, preview: string | null): boolean {
  return preview !== null && normalize(title) === normalize(preview);
}
