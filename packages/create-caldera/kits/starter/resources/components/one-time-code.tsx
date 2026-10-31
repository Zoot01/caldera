import { Fragment } from 'react'
import { OTPField, OTPFieldInput, OTPFieldSeparator } from '@/components/ui/otp-field'

/**
 * The six digits from an authenticator app. `onComplete` fires once all six are in (e.g. to submit);
 * `fill` stretches the boxes across the form (sign-in pages).
 */
export function OneTimeCode({ value, onChange, onComplete, invalid = false, autoFocus = false, fill = false }: { value: string; onChange: (value: string) => void; onComplete?: (value: string) => void; invalid?: boolean; autoFocus?: boolean; fill?: boolean }) {
  return (
    <OTPField length={6} className={fill ? 'w-full' : undefined} value={value} onValueChange={onChange} {...(onComplete ? { onValueComplete: onComplete } : {})} validationType="numeric" autoComplete="one-time-code" aria-label="Authentication code">
      {Array.from({ length: 6 }, (_, index) => (
        <Fragment key={index}>
          {index === 3 && <OTPFieldSeparator />}
          <OTPFieldInput aria-invalid={invalid || undefined} autoFocus={autoFocus && index === 0} className={fill ? 'h-11 flex-1 text-base sm:h-11' : undefined} />
        </Fragment>
      ))}
    </OTPField>
  )
}
