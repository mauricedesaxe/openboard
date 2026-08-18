import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useLocation } from "react-router";

import {
  MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH,
  MIN_PROBLEM_REPORT_DESCRIPTION_LENGTH,
  reportRoute,
} from "../shared/problem-reports";

import { trackBrowserEvent } from "./browser-telemetry";
import { useTRPC } from "./trpc";

export function ProblemReportAction({ signedIn }: { signedIn: boolean }) {
  const trpc = useTRPC();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [contactAllowed, setContactAllowed] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const openedAt = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const submit = useMutation(
    trpc.problemReports.submit.mutationOptions({
      onSuccess: () => trackBrowserEvent("problem_reported"),
    }),
  );
  function openForm() {
    openedAt.current = Date.now();
    submit.reset();
    setOpen(true);
  }
  function closeForm() {
    setOpen(false);
    setDescription("");
    setContactAllowed(false);
    setContactEmail("");
    submit.reset();
    trigger.current?.focus();
  }
  function sendReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const honeypotWebsite = form.get("website");
    submit.mutate({
      contactAllowed,
      contactEmail,
      description,
      formOpenDurationMs: Date.now() - openedAt.current,
      honeypotWebsite:
        typeof honeypotWebsite === "string" ? honeypotWebsite : "",
      route: reportRoute(location.pathname),
    });
  }
  function keepFocusInside(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeForm();
      return;
    }
    if (event.key !== "Tab" || !dialog.current) return;

    const controls = Array.from(
      dialog.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not([tabindex="-1"]), textarea',
      ),
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const rateLimited =
    submit.error?.message === "Too many reports were sent. Try again later.";

  return (
    <>
      <button
        className="problem-report-trigger"
        onClick={openForm}
        ref={trigger}
        type="button"
      >
        Report a problem
      </button>
      {open && (
        <div className="problem-report-backdrop" role="presentation">
          <section
            aria-labelledby="problem-report-title"
            aria-modal="true"
            className="problem-report-dialog"
            onKeyDown={keepFocusInside}
            ref={dialog}
            role="dialog"
          >
            {submit.isSuccess ? (
              <>
                <div className="eyebrow">Report sent</div>
                <h2 id="problem-report-title">Thanks for the heads-up.</h2>
                <p>OpenBoard’s owner was alerted.</p>
                <button
                  className="primary-button"
                  onClick={closeForm}
                  type="button"
                >
                  Close
                </button>
              </>
            ) : (
              <form onSubmit={sendReport}>
                <div className="problem-report-heading">
                  <div>
                    <div className="eyebrow">Production support</div>
                    <h2 id="problem-report-title">What went wrong?</h2>
                  </div>
                  <button
                    className="text-button"
                    onClick={closeForm}
                    type="button"
                  >
                    Close
                  </button>
                </div>
                <p className="muted">
                  Describe the problem in one or two sentences. Don’t include
                  sign-in codes or private event content.
                </p>
                <label className="problem-report-description">
                  Problem description
                  <textarea
                    autoFocus
                    maxLength={MAX_PROBLEM_REPORT_DESCRIPTION_LENGTH}
                    minLength={MIN_PROBLEM_REPORT_DESCRIPTION_LENGTH}
                    onChange={(event) => setDescription(event.target.value)}
                    required
                    value={description}
                  />
                </label>
                <label className="problem-report-honeypot" aria-hidden="true">
                  Website
                  <input autoComplete="off" name="website" tabIndex={-1} />
                </label>
                {signedIn ? (
                  <label className="problem-report-contact">
                    <input
                      checked={contactAllowed}
                      onChange={(event) =>
                        setContactAllowed(event.target.checked)
                      }
                      type="checkbox"
                    />
                    The owner may contact me through my OpenBoard account.
                  </label>
                ) : (
                  <>
                    <label className="problem-report-contact">
                      <input
                        checked={contactAllowed}
                        onChange={(event) =>
                          setContactAllowed(event.target.checked)
                        }
                        type="checkbox"
                      />
                      You can contact me about this.
                    </label>
                    {contactAllowed && (
                      <label className="problem-report-contact-email">
                        Contact email
                        <input
                          autoComplete="email"
                          onChange={(event) =>
                            setContactEmail(event.target.value)
                          }
                          placeholder="you@example.com"
                          type="email"
                          value={contactEmail}
                        />
                      </label>
                    )}
                  </>
                )}
                {submit.error && (
                  <p className="form-error" role="alert">
                    {submit.error.message}
                  </p>
                )}
                <button
                  className="primary-button"
                  disabled={submit.isPending}
                  onClick={rateLimited ? closeForm : undefined}
                  type={rateLimited ? "button" : "submit"}
                >
                  {rateLimited
                    ? "Close"
                    : submit.isPending
                      ? "Sending…"
                      : submit.isError
                        ? "Try again"
                        : "Send report"}
                </button>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}
