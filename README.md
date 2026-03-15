# AITrafficJamaica
## Real-Time AI-Powered Traffic Intelligence Platform

AITrafficJamaica transforms **live traffic camera feeds into actionable transportation intelligence** using artificial intelligence and computer vision.

Jamaica already has traffic cameras deployed across the island, but most of the data generated from these cameras remains **unanalyzed and unused**. This platform converts passive video feeds into **real-time traffic insights** that benefit drivers, transport operators, and government planners.

The system uses **computer vision, machine learning, and real-time streaming technologies** to analyze traffic conditions and provide live congestion data, vehicle classification, and transportation analytics.

---

# Overview

Jamaica's traffic cameras generate valuable data that often goes completely unanalyzed.

**AITrafficJamaica converts live camera feeds into actionable traffic intelligence**, serving:

- Everyday drivers
- Transport companies
- Logistics fleets
- City planners
- Government agencies

Through a unified **AI-powered platform**, the system transforms passive traffic cameras into **intelligent transportation sensors**.

---

# How It Works

## 1. Live Camera Ingestion
HLS traffic camera feeds are ingested continuously with:

- Auto-refreshing stream URLs  
- Multi-camera support  
- Hot-swap camera switching  
- Continuous frame processing  

## 2. YOLOv8 AI Detection
Each frame is processed using a **YOLOv8 neural network**, which:

- Detects and classifies vehicles  
- Identifies traffic density  
- Extracts valuable traffic intelligence  

Additional enhancements include:

- Night-mode detection  
- Scene classification (day / night / rain / cloudy)  
- Adaptive confidence thresholds  

## 3. ByteTrack Vehicle Tracking
ByteTrack multi-object tracking assigns **persistent vehicle IDs** across frames to:

- Track vehicle movement  
- Prevent duplicate vehicle counts  
- Monitor traffic flow across detection zones  

## 4. Real-Time Data Broadcast
Traffic detection events are streamed to connected users using **WebSockets**, providing:

- Real-time vehicle counts  
- Traffic congestion updates  
- Live analytics every ~2 seconds  

## 5. Prediction Game Engine
A built-in prediction system allows users to guess **vehicle counts within time windows**.

Predictions are resolved automatically using:

- Background resolver loops  
- Atomic database transactions  
- Real-time scoring updates  

---

# Key Features

## AI Pipeline

- Real-time vehicle detection using **YOLOv8**
- Scene classification: day / night / rain / cloudy
- ByteTrack multi-object tracking
- Adaptive frame processing based on traffic load
- Multi-camera ingestion with hot-swap support
- Dataset capture for continuous AI retraining

## Prediction Game

Users can predict traffic levels within:

- 1 minute
- 3 minutes
- 5 minutes

Game mechanics:

- Starting balance: **1,000 credits**
- Exact match: **100% points**
- Within ~40%: **50% points**
- Outside threshold: **0 points**

Prediction rounds resolve automatically every **2 seconds**.

---

# Admin Dashboard

The admin dashboard provides system monitoring and ML management tools.

Features include:

- AI loop health monitoring
- Watchdog restart tracking
- Prediction round resolver status
- Camera detection zone configuration
- Exclusion zone management
- Dataset capture tools
- Training job management
- Automatic model retraining pipelines

---

# Technology Stack

## Backend
- FastAPI  
- Python  
- YOLOv8 (Ultralytics)  
- Supervision  
- Docker  
- Railway  

## Frontend
- Vanilla JavaScript (ES Modules)  
- Vite  

## Database & Authentication
- Supabase  
- PostgreSQL  
- Realtime subscriptions  
- Authentication  

## AI / Computer Vision
- YOLOv8 object detection  
- ByteTrack object tracking  
- HLS video stream processing  

---

# User Stories

## Everyday Driver / Commuter

Drivers can:

- View live traffic camera feeds  
- Assess congestion before leaving home  
- Monitor real-time vehicle counts  
- See detection overlays showing vehicle classifications (cars, trucks, buses, motorcycles)  
- Receive alerts when camera feeds go offline  
- Participate in traffic prediction challenges  
- Track prediction accuracy and scores  

---

## Transport Company / Fleet Operator

Transport operators can:

- Monitor vehicle density on major corridors  
- Adjust bus schedules dynamically  
- Analyze peak and off-peak traffic patterns  
- Understand weather impact on traffic flow  
- Export traffic reports for operational planning  
- Receive congestion alerts  
- Monitor multiple traffic cameras simultaneously  

---

## City Planner / Government Official

Government agencies can:

- Analyze historical traffic patterns  
- Identify congestion hotspots  
- Compare traffic volumes across road networks  
- Study traffic behavior under different weather conditions  
- Create custom detection zones near schools or hospitals  
- Export traffic datasets for policy and planning  
- Retrain AI models as traffic patterns evolve  
- Monitor system reliability before official deployment  

---

# Vision

AITrafficJamaica transforms passive traffic cameras into **AI-powered transportation intelligence infrastructure**.

Instead of simply recording traffic, cameras become **real-time sensors powering Jamaica’s future Smart Mobility ecosystem**.

---

# Closing Statement

**"Jamaica already has the cameras — we're simply giving them intelligence."**
