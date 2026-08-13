import { motion, useReducedMotion } from 'motion/react'
import { Mail, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/utils'

export function CTA() {
  const reduceMotion = useReducedMotion()

  return (
    <section id="cta" aria-labelledby="cta-heading" className="mx-auto max-w-5xl px-4 py-16">
      <div
        className={cn(
          'relative overflow-hidden rounded-3xl border border-violet-200/60 bg-linear-to-br from-violet-50 via-pink-50 to-pink-100 px-6 py-16 text-center sm:px-12',
          'dark:border-violet-900/40 dark:from-violet-950 dark:via-stone-900 dark:to-pink-950',
        )}
      >
        <Sparkles className="mx-auto size-10 text-violet-500" aria-hidden="true" />

        <h2 id="cta-heading" className="mt-4 text-3xl font-bold tracking-tight text-stone-900 md:text-4xl dark:text-white">
          想更了解這隻桌寵嗎？
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-stone-600 dark:text-stone-400">
          這是還在慢慢長大的個人原型作品，歡迎來信聊聊想法、回報問題，或單純告訴我你想看牠多會什麼。
        </p>

        <motion.a
          href="mailto:hello@example.com?subject=桌寵陪伴 詢問"
          whileHover={reduceMotion ? undefined : { scale: 1.03 }}
          whileTap={reduceMotion ? undefined : { scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          className={cn(
            'mt-8 inline-flex items-center gap-2 rounded-lg bg-linear-to-r from-violet-500 to-pink-500 px-6 py-3',
            'text-sm font-semibold text-white shadow-lg shadow-violet-500/30',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
          )}
        >
          <Mail className="size-4" aria-hidden="true" />
          寄信聊聊
        </motion.a>
      </div>
    </section>
  )
}
