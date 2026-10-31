import { useForm } from '@inertiajs/react'
import { type FormEvent, useState } from 'react'
import { FormField } from '@/components/form-field'
import { Heading } from '@/components/heading'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
    <div className="space-y-6">
      <Heading size="small" title="Delete account" description="Delete your account and all of its data" />
      <Alert variant="error">
        <AlertTitle>Warning</AlertTitle>
        <AlertDescription>Please proceed with caution, this cannot be undone.</AlertDescription>
      </Alert>
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
        <AlertDialogTrigger render={<Button variant="destructive" />}>Delete account</AlertDialogTrigger>
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
              <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
              <Button type="submit" variant="destructive" loading={form.processing}>
                Delete account
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  )
}
