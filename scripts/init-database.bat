@echo off
REM Batch file to initialize the Otedama database

echo Creating data directory...
if not exist "data" mkdir data
echo Data directory created successfully!

echo Creating database file...
type nul > data\otedama.db
echo Database file created successfully!

echo Database initialization completed!
pause
