#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

CODE_DIR = Path.home() / "Documents" / "code"
EXPERIMENTS_DIR = CODE_DIR / "experiments"
UTILS_DIR = CODE_DIR / "github" / "globalprofessionalsearch" / "stacias-utils"

# Directories to skip
SKIP = {"github", "sandbox", "experiments", ".git", ".DS_Store"}

def get_directory_summary(dir_path):
    """Get a quick summary of directory contents."""
    try:
        # Get basic structure
        result = subprocess.run(
            ["ls", "-la", str(dir_path)],
            capture_output=True,
            text=True,
            timeout=5
        )
        listing = result.stdout
        
        # Check for README
        readme_content = ""
        for readme in ["README.md", "README.txt", "README"]:
            readme_path = dir_path / readme
            if readme_path.exists():
                try:
                    with open(readme_path, 'r') as f:
                        readme_content = f.read(500)  # First 500 chars
                    break
                except:
                    pass
        
        # Build prompt for LLM
        prompt = f"""Summarize this directory in 1-2 sentences:

Directory: {dir_path.name}

Contents:
{listing[:1000]}

{f'README excerpt:{readme_content}' if readme_content else ''}

Is this a utility/tool, an experiment/test, or something else?"""
        
        # Call pi CLI
        result = subprocess.run(
            ["pi", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode == 0:
            return result.stdout.strip()
        else:
            return "Could not generate summary"
            
    except Exception as e:
        return f"Error: {e}"

def main():
    # Ensure target directories exist
    EXPERIMENTS_DIR.mkdir(parents=True, exist_ok=True)
    UTILS_DIR.mkdir(parents=True, exist_ok=True)
    
    # Get all directories in code/
    dirs = sorted([d for d in CODE_DIR.iterdir() 
                   if d.is_dir() and d.name not in SKIP])
    
    for dir_path in dirs:
        print("\n" + "="*80)
        print(f"Repository: {dir_path.name}")
        print("="*80)
        
        print("\nAnalyzing...")
        summary = get_directory_summary(dir_path)
        print(f"\n{summary}\n")
        
        while True:
            choice = input("Move to [e]xperiments, [u]tilities, [s]kip, or [q]uit? ").lower().strip()
            
            if choice == 'e':
                target = EXPERIMENTS_DIR / dir_path.name
                dir_path.rename(target)
                print(f"✓ Moved to experiments")
                break
            elif choice == 'u':
                target = UTILS_DIR / dir_path.name
                dir_path.rename(target)
                print(f"✓ Moved to utilities")
                break
            elif choice == 's':
                print("Skipped")
                break
            elif choice == 'q':
                print("Exiting...")
                sys.exit(0)
            else:
                print("Invalid choice. Please enter e, u, s, or q.")
    
    print("\n" + "="*80)
    print("Done!")
    print("="*80)

if __name__ == "__main__":
    main()
