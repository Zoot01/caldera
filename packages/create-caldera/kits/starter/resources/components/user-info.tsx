import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { avatarColor } from '@/lib/avatar-color'
import { cn } from '@/lib/utils'

export interface UserSummary {
  name: string
  email: string
  image: string | null
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')

/** A person's picture, or their initials on their colour (avatarColor). */
export function UserAvatar({ user, className }: { user: UserSummary; className?: string }) {
  return (
    <Avatar className={cn('size-8 overflow-hidden rounded-full', className)}>
      {user.image && <AvatarImage src={user.image} alt={user.name} />}
      <AvatarFallback className={cn('rounded-full border font-medium', avatarColor(user.name))}>{initials(user.name)}</AvatarFallback>
    </Avatar>
  )
}

export function UserInfo({ user, showEmail = false }: { user: UserSummary; showEmail?: boolean }) {
  return (
    <>
      <UserAvatar user={user} />
      <div className="grid flex-1 text-start text-sm leading-tight">
        <span className="truncate font-medium">{user.name}</span>
        {showEmail && <span className="truncate text-muted-foreground text-xs">{user.email}</span>}
      </div>
    </>
  )
}
