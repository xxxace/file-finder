export async function postAction(url: string, data: object) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    })

    const json = await response.json()
    return json
}

export async function deletAction(url: string) {
    const response = await fetch(url, {
        method: "DELETE",
    })

    const json = await response.json()
    return json
}