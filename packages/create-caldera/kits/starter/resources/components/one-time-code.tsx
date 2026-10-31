import { Fragment } from 'react'
import { OTPField, OTPFieldInput, OTPFieldSeparator } from '@/components/ui/otp-field'

/** The six digits from an authenticator app. `onComplete` fires once all six are in (e.g. to submit). */
export function OneTimeCode({ value, onChange, onComplete, invalid = false, autoFocus = false }: { value: string; onChange: (value: string) => void; onComplete?: (value: string) => void; invalid?: boolean; autoFocus?: boolean }) {
  return (
    <OTPField length={6} value={value} onValueChange={onChange} {...(onComplete ? { onValueComplete: onComplete } : {})} validationType="numeric" autoComplete="one-time-code" aria-label="Authentication code">
      {Array.from({ length: 6 }, (_, index) => (
        <Fragment key={index}>
          {index === 3 && <OTPFieldSeparator />}
          <OTPFieldInput aria-invalid={invalid || undefined} autoFocus={autoFocus && index === 0} />
        </Fragment>
      ))}
    </OTPField>
  )
}
