import type { Metadata } from "next"
import { IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google"

import "./globals.css"

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
})

const plexSerif = IBM_Plex_Serif({
  variable: "--font-plex-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
})

export const metadata: Metadata = {
  title: "Law Listener",
  description: "Offentlig, lesbar oversikt over lovbeslutninger og koblede lover.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="nb">
      <body className={`${plexSans.variable} ${plexSerif.variable} antialiased`}>
        {children}
      </body>
    </html>
  )
}
