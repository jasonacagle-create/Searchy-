exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { images } = JSON.parse(event.body);
    const apiKey = process.env.OPENAI_API_KEY;
    const pages = [];

    for (const img of images) {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: "Extract chapter number, page number, title, and text from this textbook page." },
              { type: "input_image", image_url: img.imageDataUrl }
            ]
          }]
        })
      });

      const data = await response.json();

      pages.push({
        filename: img.filename,
        chapter: null,
        page: null,
        title: "",
        text: JSON.stringify(data)
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ pages })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: error.toString()
    };
  }
};