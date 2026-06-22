import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn

app = FastAPI(
    title="CAFFIX Coffee Vending Machine API",
    description="Backend API configuration enabling local hosting for the Raspberry Pi 5 touch interface.",
    version="1.0.0"
)

# Explicit route for root
@app.get("/")
async def get_index():
    react_index = "caffix-app/dist/index.html"
    if os.path.exists(react_index):
        return FileResponse(react_index)
    return FileResponse("index.html")

# Mount static frontend root (html, css, js)
if os.path.exists("caffix-app/dist"):
    app.mount("/", StaticFiles(directory="caffix-app/dist", html=True), name="static")
else:
    if os.path.exists("assets"):
        app.mount("/assets", StaticFiles(directory="assets"), name="assets")
    app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    print("----------------------------------------------------------------")
    print("CAFFIX Vending Kiosk server booting up...")
    print("URL: http://localhost:8000")
    print("Touch interface optimized: Use Chromium in kiosk mode:")
    print("chromium-browser --kiosk --app=http://localhost:8000")
    print("----------------------------------------------------------------")
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
