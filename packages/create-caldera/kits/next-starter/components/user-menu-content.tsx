'use client'

import { LogOut, Settings } from 'lucide-react'
import Link from 'next/link'
import { logout } from '@/app/actions/auth'
import { MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from '@/components/ui/menu'
import { UserInfo, type UserSummary } from '@/components/user-info'

/** The signed-in user's menu: settings and signing out. */
export function UserMenuContent({ user }: { user: UserSummary }) {
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel className="flex items-center gap-2 px-1 py-1.5 font-normal">
          <UserInfo user={user} showEmail />
        </MenuGroupLabel>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem render={<Link href="/settings/profile" />}>
        <Settings />
        Settings
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => void logout()}>
        <LogOut />
        Log out
      </MenuItem>
    </>
  )
}
