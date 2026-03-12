import { build } from 'vite'

try {
  await build()
  console.log('vite build ok')
} catch (error) {
  console.error(error)
  process.exit(1)
}
