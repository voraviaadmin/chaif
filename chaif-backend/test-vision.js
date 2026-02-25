const vision = require("@google-cloud/vision");

async function test() {
  const client = new vision.ImageAnnotatorClient();
  const [result] = await client.documentTextDetection("/Users/jayanthivanaparthy/Documents/CostcoReceipt_1.pdf");
  console.log(result.fullTextAnnotation?.text?.slice(0, 500));
}

test().catch(console.error);