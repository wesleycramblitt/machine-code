tags: runs

# Runs
Plan features for adding new settings if they don't already exist.

1.) model call cap per run. Default to 50 calls. 
2.) Per issue auto retry count on accpetance gate failure. Default to 5. 
3.) Duplicate call guard (model asking for the same thing over and over back to back. Block after 3 duplicate calls. Have to be exactly the same for this. Mostly to stop corrupt models from wasting tokens)


