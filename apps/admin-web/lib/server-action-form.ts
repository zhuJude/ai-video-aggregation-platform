/**
 * React adds opaque $ACTION_* fields to native server-action forms. Keep those
 * framework fields outside the strict domain-command boundary.
 */
export function domainFormData(form: FormData): FormData {
  const result = new FormData();
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('$ACTION_')) result.append(key, value);
  }
  return result;
}
