#!/usr/bin/env python3

import os
import sqlite3

def init_database():
    # Create data directory if it doesn't exist
    data_dir = "./data"
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)
        print(f"Created data directory: {data_dir}")
    
    # Database path
    db_path = os.path.join(data_dir, "otedama.db")
    
    # Create database file if it doesn't exist
    if not os.path.exists(db_path):
        open(db_path, 'a').close()
        print(f"Created database file: {db_path}")
    else:
        print(f"Database file already exists: {db_path}")
    
    # Connect to database
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Create tables
    tables = [
        '''CREATE TABLE IF NOT EXISTS workers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            wallet_address TEXT NOT NULL,
            hashrate REAL DEFAULT 0,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );''',
        
        '''CREATE TABLE IF NOT EXISTS shares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id INTEGER NOT NULL,
            job_id TEXT NOT NULL,
            nonce TEXT NOT NULL,
            difficulty REAL NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (worker_id) REFERENCES workers (id)
        );''',
        
        '''CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            height INTEGER NOT NULL,
            hash TEXT NOT NULL UNIQUE,
            worker_id INTEGER,
            reward REAL,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (worker_id) REFERENCES workers (id)
        );''',
        
        '''CREATE TABLE IF NOT EXISTS payouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            tx_id TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (worker_id) REFERENCES workers (id)
        );'''
    ]
    
    for table in tables:
        cursor.execute(table)
    
    conn.commit()
    conn.close()
    
    print("Database initialization completed successfully!")

if __name__ == "__main__":
    init_database()
