/** Running indicator mark: a spinning arc drawn in the deployment accent. */
import css from './ChatView.module.css'

/**
 * Render the decorative running icon.
 * @returns the spinning arc, hidden from assistive technology because the status text announces the run.
 */
export function RunningWhaleTail() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg className={css.runningSpin} width="100%" height="100%" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.4" />
        <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  )
}
