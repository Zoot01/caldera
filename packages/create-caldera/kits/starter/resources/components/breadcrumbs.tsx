import { Link } from '@inertiajs/react'
import { Fragment } from 'react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import type { BreadcrumbItem as Item } from '@/types'

export function Breadcrumbs({ breadcrumbs }: { breadcrumbs: Item[] }) {
  if (breadcrumbs.length === 0) return null
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {breadcrumbs.map((item, index) => (
          <Fragment key={item.href}>
            <BreadcrumbItem>
              {index === breadcrumbs.length - 1 ? <BreadcrumbPage>{item.title}</BreadcrumbPage> : <BreadcrumbLink render={<Link href={item.href} />}>{item.title}</BreadcrumbLink>}
            </BreadcrumbItem>
            {index < breadcrumbs.length - 1 && <BreadcrumbSeparator />}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
