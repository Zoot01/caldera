import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

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

export function UserInfo({ user, showEmail = false }: { user: UserSummary; showEmail?: boolean }) {
  return (
    <>
      <Avatar className="size-8 overflow-hidden rounded-full">
        {user.image && <AvatarImage src={user.image} alt={user.name} />}
        <AvatarFallback className="rounded-lg">{initials(user.name)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-start text-sm leading-tight">
        <span className="truncate font-medium">{user.name}</span>
        {showEmail && <span className="truncate text-muted-foreground text-xs">{user.email}</span>}
      </div>
    </>
  )
}
