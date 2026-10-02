import { Text, type TextProps } from 'react-native'

const variants = {
  display: 'text-4xl leading-11 font-bold',
  headline: 'text-2xl leading-8 font-semibold',
  title: 'text-lg leading-6 font-medium',
  body: 'text-base leading-6',
  label: 'text-sm leading-5 font-medium',
}

const tones = {
  default: 'text-foreground',
  muted: 'text-muted',
  danger: 'text-danger',
  success: 'text-success',
}

export type AppTextProps = TextProps & {
  variant: keyof typeof variants
  tone?: keyof typeof tones
}

/** Text in one of the app's type roles (Material 3 sizes, Roboto). */
export function AppText({ variant, tone = 'default', className, ...props }: AppTextProps) {
  return (
    <Text
      accessibilityRole={variant === 'headline' ? 'header' : undefined}
      className={`${variants[variant]} ${tones[tone]} ${className ?? ''}`}
      {...props}
    />
  )
}
