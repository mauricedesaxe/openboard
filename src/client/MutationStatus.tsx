export function MutationStatus({
  error,
  success,
}: {
  error?: string | undefined;
  success?: string | undefined;
}) {
  if (error) {
    return (
      <p className="mutation-notice mutation-notice-error" role="alert">
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p className="mutation-notice mutation-notice-success" role="status">
        {success}
      </p>
    );
  }
  return null;
}
