import os
from datetime import datetime
from typing import List, Optional
from sqlalchemy import Column, Integer, String, Boolean, Float, Text, DateTime, ForeignKey, create_engine, text, event
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from backend.runtime import get_data_root, migrate_legacy_data_file

DB_PATH = os.path.join(get_data_root(), "library.db")
migrate_legacy_data_file(os.path.join("backend", "library.db"), DB_PATH)
DATABASE_URL = f"sqlite:///{DB_PATH}"

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA cache_size=-64000")
    except Exception:
        pass
    finally:
        cursor.close()

Base = declarative_base()

class Game(Base):
    __tablename__ = "games"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True, nullable=False)
    raw_name = Column(String, nullable=False)
    category = Column(String, index=True, default="General")
    folder_path = Column(String, unique=True, index=True, nullable=False)
    file_type = Column(String, default="exe")  # "exe", "archive", "folder"
    archive_name = Column(String, nullable=True)
    size_bytes = Column(Integer, default=0)
    
    # Metadata identification
    source_type = Column(String, default="unknown")  # "f95zone", "dlsite", "itch", "steam", "unknown"
    source_url = Column(String, nullable=True)
    source_id = Column(String, index=True, nullable=True)
    is_identified = Column(Boolean, default=False)
    
    # Versioning & Updates
    local_version = Column(String, nullable=True)
    latest_version = Column(String, nullable=True)
    update_available = Column(Boolean, default=False, index=True)
    last_update_check_at = Column(DateTime, nullable=True)
    last_update_check_status = Column(String, default="never")
    last_update_check_error = Column(Text, nullable=True)
    update_detected_at = Column(DateTime, nullable=True)
    local_version_is_manual = Column(Boolean, default=False)
    title_is_manual = Column(Boolean, default=False)
    
    # Rich details
    rating = Column(String, nullable=True)
    developer = Column(String, nullable=True)
    release_date = Column(String, nullable=True)
    cover_url = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    
    # User status & tracking (XLibrary style)
    playing_progress = Column(String, default="unplayed", index=True)  # "unplayed", "playing", "completed", "on_hold"
    user_score = Column(String, nullable=True)  # user star rating
    is_ignored = Column(Boolean, default=False, index=True)
    missing_scan_count = Column(Integer, default=0)
    total_playtime_seconds = Column(Integer, default=0)
    play_session_count = Column(Integer, default=0)
    
    # Timestamps
    added_at = Column(DateTime, default=datetime.utcnow, index=True)
    last_played = Column(DateTime, nullable=True)
    last_seen_at = Column(DateTime, default=datetime.utcnow)
    
    # Relationships
    sources = relationship("GameSource", back_populates="game", cascade="all, delete-orphan", lazy="selectin")
    screenshots = relationship("Screenshot", back_populates="game", cascade="all, delete-orphan", lazy="selectin")
    tags = relationship("Tag", back_populates="game", cascade="all, delete-orphan", lazy="selectin")
    custom_tags = relationship("CustomTag", back_populates="game", cascade="all, delete-orphan", lazy="selectin")
    journal_entries = relationship("JournalEntry", back_populates="game", cascade="all, delete-orphan", lazy="selectin")
    
    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "raw_name": self.raw_name,
            "category": self.category,
            "folder_path": self.folder_path,
            "file_type": self.file_type,
            "archive_name": self.archive_name,
            "size_bytes": self.size_bytes,
            "source_type": self.source_type,
            "source_url": self.source_url,
            "source_id": self.source_id,
            "is_identified": self.is_identified,
            "local_version": self.local_version,
            "latest_version": self.latest_version,
            "update_available": self.update_available,
            "last_update_check_at": self.last_update_check_at.isoformat() if self.last_update_check_at else None,
            "last_update_check_status": self.last_update_check_status or "never",
            "last_update_check_error": self.last_update_check_error,
            "update_detected_at": self.update_detected_at.isoformat() if self.update_detected_at else None,
            "local_version_is_manual": bool(self.local_version_is_manual),
            "title_is_manual": bool(self.title_is_manual),
            "rating": self.rating,
            "developer": self.developer,
            "release_date": self.release_date,
            "cover_url": self.cover_url,
            "description": self.description,
            "playing_progress": self.playing_progress or "unplayed",
            "user_score": self.user_score,
            "is_ignored": self.is_ignored,
            "missing_scan_count": self.missing_scan_count or 0,
            "total_playtime_seconds": self.total_playtime_seconds or 0,
            "play_session_count": self.play_session_count or 0,
            "added_at": self.added_at.isoformat() if self.added_at else None,
            "last_played": self.last_played.isoformat() if self.last_played else None,
            "last_seen_at": self.last_seen_at.isoformat() if self.last_seen_at else None,
            "sources": [s.to_dict() for s in self.sources],
            "screenshots": [s.url for s in self.screenshots],
            "tags": [t.tag_name for t in self.tags],
            "custom_tags": [ct.tag_name for ct in self.custom_tags],
            "journal_entries": [{"id": j.id, "text": j.entry_text, "date": j.created_at.strftime("%b %d, %Y %H:%M")} for j in self.journal_entries]
        }

class Screenshot(Base):
    __tablename__ = "screenshots"

    id = Column(Integer, primary_key=True, index=True)
    game_id = Column(Integer, ForeignKey("games.id"), nullable=False)
    url = Column(String, nullable=False)
    local_path = Column(String, nullable=True)

    game = relationship("Game", back_populates="screenshots")

class Tag(Base):
    __tablename__ = "tags"

    id = Column(Integer, primary_key=True, index=True)
    game_id = Column(Integer, ForeignKey("games.id"), nullable=False)
    tag_name = Column(String, index=True, nullable=False)

    game = relationship("Game", back_populates="tags")

class CustomTag(Base):
    __tablename__ = "custom_tags"

    id = Column(Integer, primary_key=True, index=True)
    game_id = Column(Integer, ForeignKey("games.id"), nullable=False)
    tag_name = Column(String, index=True, nullable=False)

    game = relationship("Game", back_populates="custom_tags")

class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id = Column(Integer, primary_key=True, index=True)
    game_id = Column(Integer, ForeignKey("games.id"), nullable=False)
    entry_text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    game = relationship("Game", back_populates="journal_entries")

class GameSource(Base):
    __tablename__ = "game_sources"

    id = Column(Integer, primary_key=True, index=True)
    game_id = Column(Integer, ForeignKey("games.id", ondelete="CASCADE"), nullable=False)
    source_type = Column(String, nullable=False, index=True)  # "f95zone", "dlsite", "itch", "steam"
    source_url = Column(String, nullable=False)
    source_id = Column(String, nullable=True)
    title_reported = Column(String, nullable=True)
    version_reported = Column(String, nullable=True)
    is_preferred = Column(Boolean, default=False)
    added_at = Column(DateTime, default=datetime.utcnow)

    game = relationship("Game", back_populates="sources")

    def to_dict(self):
        return {
            "id": self.id,
            "source_type": self.source_type,
            "source_url": self.source_url,
            "source_id": self.source_id,
            "title_reported": self.title_reported,
            "version_reported": self.version_reported,
            "is_preferred": self.is_preferred,
            "added_at": self.added_at.isoformat() if self.added_at else None
        }

def init_db():
    Base.metadata.create_all(bind=engine)
    # Lightweight migration for existing SQLite databases
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE games ADD COLUMN playing_progress VARCHAR DEFAULT 'unplayed'"))
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE games ADD COLUMN user_score VARCHAR"))
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE games ADD COLUMN is_ignored BOOLEAN DEFAULT 0"))
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE games ADD COLUMN missing_scan_count INTEGER DEFAULT 0"))
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE games ADD COLUMN last_seen_at DATETIME"))
            conn.execute(text("UPDATE games SET last_seen_at = COALESCE(last_seen_at, added_at, CURRENT_TIMESTAMP)"))
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE games ADD COLUMN total_playtime_seconds INTEGER DEFAULT 0"))
            conn.execute(text("UPDATE games SET total_playtime_seconds = COALESCE(total_playtime_seconds, 0)"))
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE games ADD COLUMN play_session_count INTEGER DEFAULT 0"))
            conn.execute(text("UPDATE games SET play_session_count = COALESCE(play_session_count, 0)"))
        except Exception:
            pass
        for statement in (
            "ALTER TABLE games ADD COLUMN last_update_check_at DATETIME",
            "ALTER TABLE games ADD COLUMN last_update_check_status VARCHAR DEFAULT 'never'",
            "ALTER TABLE games ADD COLUMN last_update_check_error TEXT",
            "ALTER TABLE games ADD COLUMN update_detected_at DATETIME",
            "ALTER TABLE games ADD COLUMN local_version_is_manual BOOLEAN DEFAULT 0",
            "ALTER TABLE games ADD COLUMN title_is_manual BOOLEAN DEFAULT 0",
        ):
            try:
                conn.execute(text(statement))
            except Exception:
                pass
        try:
            conn.execute(text(
                "UPDATE games SET last_update_check_status = CASE "
                "WHEN last_update_check_status = 'checking' THEN 'never' "
                "ELSE COALESCE(last_update_check_status, 'never') END"
            ))
            conn.execute(text(
                "UPDATE games SET local_version_is_manual = COALESCE(local_version_is_manual, 0)"
            ))
            conn.execute(text(
                "UPDATE games SET title_is_manual = COALESCE(title_is_manual, 0)"
            ))
        except Exception:
            pass
        try:
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_games_playing_progress ON games (playing_progress)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_games_is_ignored ON games (is_ignored)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_games_added_at ON games (added_at)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_games_update_available ON games (update_available)"))
        except Exception:
            pass
        conn.commit()

    # Backfill game_sources for already identified games
    with SessionLocal() as db_session:
        try:
            from backend.versioning import apply_comparison_to_game
            for game in db_session.query(Game).all():
                if game.latest_version or game.update_available:
                    apply_comparison_to_game(game)
            identified_games = db_session.query(Game).filter(Game.is_identified == True, Game.source_type != "unknown", Game.source_url != None).all()
            for g in identified_games:
                if not g.sources:
                    db_session.add(GameSource(
                        game_id=g.id,
                        source_type=g.source_type,
                        source_url=g.source_url,
                        source_id=g.source_id,
                        title_reported=g.title,
                        version_reported=g.latest_version,
                        is_preferred=True
                    ))
            db_session.commit()
        except Exception:
            db_session.rollback()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
