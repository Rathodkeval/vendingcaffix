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
    return FileResponse("legacy-frontend/index.html")

# Mount static frontend root (html, css, js)
if os.path.exists("caffix-app/dist"):
    app.mount("/", StaticFiles(directory="caffix-app/dist", html=True), name="static")
else:
    if os.path.exists("legacy-frontend/assets"):
        app.mount("/assets", StaticFiles(directory="legacy-frontend/assets"), name="assets")
    app.mount("/", StaticFiles(directory="legacy-frontend", html=True), name="static")

if __name__ == "__main__":
    machine_id = os.getenv("MACHINE_ID", "CFX-MC-01")
    kiosk_secret = os.getenv("KIOSK_SECRET", "Kx8P2mL9Qv4Rz7Tn5Yh1")
    kiosk_url = f"http://localhost:8000/?kiosk={kiosk_secret}&machine_id={machine_id}"
    print("----------------------------------------------------------------")
    print(f"CAFFIX Vending Kiosk server booting up for Machine: {machine_id}")
    print(f"Local Kiosk URL: {kiosk_url}")
    print("Touch interface optimized: Use Chromium in kiosk mode:")
    print(f'chromium-browser --kiosk --app="{kiosk_url}"')
    print("----------------------------------------------------------------")
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
