export function Heading({ title, description, size = 'default' }: { title: string; description?: string; size?: 'default' | 'small' }) {
  return (
    <header className={size === 'small' ? 'space-y-0.5' : 'mb-8 space-y-0.5'}>
      <h2 className={size === 'small' ? 'font-medium text-base' : 'font-medium text-xl tracking-tight'}>{title}</h2>
      {description && <p className="text-muted-foreground text-sm">{description}</p>}
    </header>
  )
}
