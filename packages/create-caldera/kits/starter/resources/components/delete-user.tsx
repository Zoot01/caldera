import { useForm } from '@inertiajs/react'
import { type FormEvent, useState } from 'react'
import { FormField } from '@/components/form-field'
import { Section } from '@/components/section'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** Deletes the account and everything that belongs to it, after asking for the password. */
export function DeleteUser() {
  const [open, setOpen] = useState(false)
  const form = useForm({ password: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.delete('/settings/profile', { preserveScroll: true, onFinish: () => form.reset() })
  }
  return (
    <Section title="Delete account" description="Delete your account and all of its data" tone="danger">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground text-sm">This can’t be undone: everything in your account goes with it.</p>
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) {
              form.reset()
              form.clearErrors()
            }
          }}
        >
          <AlertDialogTrigger render={<Button variant="destructive-outline" className="shrink-0" />}>Delete account</AlertDialogTrigger>
          <AlertDialogPopup>
            <form onSubmit={submit} className="contents">
              <AlertDialogHeader>
                <AlertDialogTitle>Are you sure you want to delete your account?</AlertDialogTitle>
                <AlertDialogDescription>
                  Once your account is deleted, all of its data will be permanently deleted. Enter your password to confirm.
                </AlertDialogDescription>
                <div className="pt-2">
                  <FormField label="Password" error={form.errors.password}>
                    <Input type="password" autoComplete="current-password" autoFocus placeholder="Password" value={form.data.password} onChange={(e) => form.setData('password', e.target.value)} />
                  </FormField>
                </div>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button type="submit" variant="destructive" loading={form.processing}>
                  Delete account
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogPopup>
        </AlertDialog>
      </div>
    </Section>
  )
}
