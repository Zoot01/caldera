import { useForm } from '@inertiajs/react'
import { type FormEvent, type ReactElement, type ReactNode, useState } from 'react'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/** Asks for the password, then sends it with `method` to `url` (for changes that need it). */
export function PasswordDialog({
  trigger,
  label,
  title,
  description,
  method,
  url,
  submit,
  destructive = false,
}: {
  /** The button that opens it (`<Button variant="outline" />`), and its text. */
  trigger: ReactElement
  label: ReactNode
  title: string
  description: string
  method: 'post' | 'delete'
  url: string
  submit: string
  destructive?: boolean
}) {
  const [open, setOpen] = useState(false)
  const form = useForm({ password: '' })
  const send = (event: FormEvent) => {
    event.preventDefault()
    form.submit(method, url, { preserveScroll: true, onSuccess: () => setOpen(false), onFinish: () => form.reset() })
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
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} loading={form.processing}>
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
