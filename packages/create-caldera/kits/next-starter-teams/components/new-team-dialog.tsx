'use client'

import { useForm } from '@caldera/next/client'
import { type FormEvent, useEffect, useState } from 'react'
import { createTeam } from '@/app/actions/teams'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const openers = new Set<() => void>()

/** Opens the New team dialog from anywhere: the team switcher, the command menu, Settings → Teams. */
export function openNewTeamDialog() {
  for (const open of openers) open()
}

/** Asks for a name and makes the team, which becomes the current one. The team switcher renders it. */
export function NewTeamDialog() {
  const [open, setOpen] = useState(false)
  const form = useForm({ name: '' })
  useEffect(() => {
    const opener = () => setOpen(true)
    openers.add(opener)
    return () => void openers.delete(opener)
  }, [])
  const create = (event: FormEvent) => {
    event.preventDefault()
    // On to the new team's settings page.
    form.submit(createTeam, { onSuccess: () => setOpen(false) })
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
      <DialogPopup className="sm:max-w-md">
        <form onSubmit={create} className="contents">
          <DialogHeader>
            <DialogTitle>New team</DialogTitle>
            <DialogDescription>Work together with others. You'll be its owner, and it becomes your current team.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <FormField label="Team name" error={form.errors.name}>
              <Input autoFocus required placeholder="Acme" value={form.data.name} onChange={(e) => form.setData('name', e.target.value)} />
            </FormField>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" loading={form.processing}>
              Create team
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
