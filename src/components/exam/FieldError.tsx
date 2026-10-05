export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p className="field-error" id={id} role="alert" data-testid={id}>
      {message}
    </p>
  );
}
