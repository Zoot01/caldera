'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Fragment } from 'react'
import { breadcrumbsFor } from '@/components/navigation'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'

/** Where this page is, from the navigation (components/navigation.ts): Settings › Profile. */
export function Breadcrumbs() {
  const breadcrumbs = breadcrumbsFor(usePathname())
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
