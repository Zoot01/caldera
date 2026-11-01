'use client'

import { type ActionResult, useForm } from '@caldera/next/client'
import { type FormEvent, type ReactElement, type ReactNode, useState } from 'react'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/** Asks for the password, then calls `action` with it (a server action, for changes that need it). */
export function PasswordDialog({
  trigger,
  label,
  title,
  description,
  action,
  submit,
  destructive = false,
}: {
  /** The button that opens it (`<Button variant="outline" />`), and its text. */
  trigger: ReactElement
  label: ReactNode
  title: string
  description: string
  action: (data: { password: string }) => Promise<ActionResult | void>
  submit: string
  destructive?: boolean
}) {
  const [open, setOpen] = useState(false)
  const form = useForm({ password: '' })
  const send = (event: FormEvent) => {
    event.preventDefault()
    form.submit(action, { onSuccess: () => setOpen(false), onFinish: () => form.reset() })
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          form.reset()
          form.clearErrors()
        }
      }}
    >
      <DialogTrigger render={trigger}>{label}</DialogTrigger>
      <DialogPopup>
        <form onSubmit={send} className="contents">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <FormField label="Password" error={form.errors.password}>
              <Input type="password" autoComplete="current-password" autoFocus value={form.data.password} onChange={(e) => form.setData('password', e.target.value)} />
            </FormField>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} loading={form.processing}>
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
