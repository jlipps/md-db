import {basename} from 'node:path'

export function fileNameToSlug(file: string) {
  const fileName = basename(file)
  return fileName.replace(/^[0-9]+-/, '').replace(/\.md$/, '')
}

