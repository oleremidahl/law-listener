import { expect, test, type Route } from "@playwright/test"

const proposalId = "d4d87de7-e28f-44c9-b6c5-0f899f9a3201"

test("smoke flow: list -> filter -> detail", async ({ page }) => {
  await page.route(`**/api/proposals/${proposalId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        proposal: {
          id: proposalId,
          title: "Endringer i skatteloven",
          status: "vedtatt",
          decision_date: "2026-02-01",
          enforcement_date: "KONGEN_BESTEMMER",
          feed_description: "Forslaget gjelder modernisering av skattereglene.",
          stortinget_link: "https://stortinget.no/vedtak/1",
          lovdata_link: null,
        },
        linkedDocuments: [
          {
            id: "f8df4ea6-67cb-4f9d-8146-a96998742ce6",
            dokid: "LOV-2017-06-16-60",
            legacy_id: "LOV-2017-06-16-60",
            title: "Skatteforvaltningsloven",
            short_title: "Skatteforvaltningsloven",
            document_type: "lov",
          },
        ],
        summary: {
          status: "ready",
          data: "Forslaget moderniserer skattereglene.",
          generated_at: "2026-02-10T10:00:00.000Z",
          next_retry_at: null,
        },
      }),
    })
  })

  const listHandler = async (route: Route) => {
    const requestUrl = new URL(route.request().url())
    const q = requestUrl.searchParams.get("q")

    const items =
      q && q.toLowerCase().includes("modernisering")
        ? [
            {
              id: proposalId,
              title: "Endringer i skatteloven",
              feed_description: "Forslaget gjelder modernisering av skattereglene.",
              status: "vedtatt",
              decision_date: "2026-02-01",
              enforcement_date: "STRAKS",
              stortinget_link: "https://stortinget.no/vedtak/1",
              lovdata_link: null,
            },
          ]
        : [
            {
              id: proposalId,
              title: "Endringer i skatteloven",
              feed_description: "Forslaget gjelder modernisering av skattereglene.",
              status: "vedtatt",
              decision_date: "2026-02-01",
              enforcement_date: "STRAKS",
              stortinget_link: "https://stortinget.no/vedtak/1",
              lovdata_link: null,
            },
          ]

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        pagination: {
          page: 1,
          pageSize: 20,
          totalPages: 1,
          totalCount: items.length,
        },
      }),
    })
  }

  await page.route("**/api/proposals", listHandler)
  await page.route("**/api/proposals?*", listHandler)

  await page.goto("/")

  await expect(
    page.getByRole("heading", {
      name: "Oversikt over lovbeslutninger i Stortinget",
      level: 1,
    })
  ).toBeVisible()

  await expect(page.getByText("Endringer i skatteloven")).toBeVisible()
  await expect(
    page.getByText("Trer i kraft så snart kongen har sanksjonert forslaget.")
  ).toBeVisible()

  await page.getByLabel("Søk i beskrivelse").fill("modernisering")
  await page.getByRole("button", { name: "Filtrer" }).click()

  await expect(page).toHaveURL(/q=modernisering/)

  await page.getByText("Forslaget gjelder modernisering av skattereglene.").click()

  await expect(page).toHaveURL(new RegExp(`/proposal/${proposalId}`))
  await expect(page.getByText("Koblede lover")).toBeVisible()
  await expect(page.getByText("LOV-2017-06-16-60")).toBeVisible()
  await expect(page.getByRole("link", { name: "Åpne på Stortinget" })).toBeVisible()
  await expect(
    page.getByText("Kongen fastsetter dato under kongelig resolusjon.")
  ).toBeVisible()
})
