class DeploymentMode {
    /** 
     * Functions are redeployed during each execution.
     * Enable this mode, if a shared database instance is used in development.
     */
    static DEV = "DEV";

    /** 
     * Functions are automatically redeployed each time 
     * a function implementation is changed. This is the default mode. */
    static AUTO = "AUTO";

    /** 
     * Functions are never redeployed automatically and 
     * need to be manually created on the database end.
     */
    static MANUAL = "MANUAL";
}

class Deployment {

    static #DEPLOYMENT_TABLE_NAME = "pg_compute";
    static #DEPLOYMENT_TABLE_COLUMNS =
        "(name text NOT NULL," +
        "args text," +
        "body_hashcode int8," +
        "PRIMARY KEY(name, args));";

    /** Deployment mode. */
    #deploymentMode;

    /** Schema name. */
    #schema;

    /** Full meta table name */
    #deploymentTableFullName;

    /** */
    #deploymentTable = {};

    constructor(mode = DeploymentMode.AUTO, schema = "public") {
        this.#deploymentMode = mode;
        this.#schema = schema;
    }

    async init(dbClient) {
        console.debug("Initialized " + this.#deploymentMode + " deployment mode");

        this.#schema = dbClient.escapeIdentifier(this.#schema);
        this.#deploymentTableFullName = this.#schema + "." + Deployment.#DEPLOYMENT_TABLE_NAME;

        // TODO: handle database errors
        await dbClient.query("CREATE SCHEMA IF NOT EXISTS " + this.#schema);

        await dbClient.query("CREATE TABLE IF NOT EXISTS " +
            this.#deploymentTableFullName + Deployment.#DEPLOYMENT_TABLE_COLUMNS);

        await this.#loadDeploymentTable(dbClient);
    }

    async checkExists(dbClient, funcName, funcArgs, funcBody) {
        let funcRecord = this.#deploymentTable[funcName];

        if (funcArgs == undefined || funcArgs == null)
            funcArgs = "";

        if (funcRecord == undefined) {
            if (this.#deploymentMode == DeploymentMode.MANUAL) {
                //TODO: make a call to the DB because another session might have created the function
                throw new Error("Function '" + funcName + "' is not deployed.\n" +
                    "The current DeploymentMode is MANUAL. Switch to DeploymentMode.AUTO for automatic redeployment.")
            }

            await this.#createFunction(dbClient, funcName, funcArgs, funcBody, false);

            console.debug("Function '" + funcName + "' has been deployed");

            return;

        } else if (funcRecord['args'] != funcArgs) {
            if (this.#deploymentMode == DeploymentMode.MANUAL) {
                //TODO: make a call to the DB because another session might have created the function
                throw new Error("Function '" + funcName + "' deployed but has different arguments.\n" +
                    "The current DeploymentMode is MANUAL. Switch to DeploymentMode.AUTO for automatic redeployment.")
            }

            await this.#createFunction(dbClient, funcName, funcArgs, funcBody, true);

            console.debug("Function '" + funcName + "' has been redeployed");

            return;
        }

        console.debug("Function '" + funcName + "' exists");
    }

    async #loadDeploymentTable(dbClient) {
        const result = await dbClient.query({
            text: "SELECT * FROM " + this.#deploymentTableFullName,
            name: "get_meta_" + this.#deploymentTableFullName
        });

        if (result.rows.length > 0) {
            result.rows.forEach(row => {
                this.#deploymentTable[row['name']] = { "args": row['args'], "bodyHashCode": row["body_hashcode"] };
            });
        }

        console.debug("Loaded the meta table:\n %j", this.#deploymentTable);
    }

    async #createFunction(dbClient, funcName, funcArgs, funcBody, redeploy) {
        let stmt;

        if (funcArgs == undefined) {
            stmt = "create or replace function " + funcName + "() returns JSON as $$" +
                funcBody +
                "$$ language plv8;"
        } else {
            stmt = "create or replace function " + funcName + "(" + funcArgs + ") returns JSON as $$" +
                funcBody +
                "$$ language plv8;"
        }

        const bodyHashCode = 123243;


        await dbClient.query("BEGIN;");
        await dbClient.query(stmt);

        if (redeploy) {
            await dbClient.query(
                {
                    name: "pg_compute_delete_" + this.#deploymentTableFullName,
                    text: "DELETE FROM " + this.#deploymentTableFullName + " WHERE name = $1 and args = $2;",
                    values: [funcName, this.#deploymentTable[funcName]["args"]]
                }
            );

        }

        await dbClient.query(
            {
                name: "pg_compute_insert_" + this.#deploymentTableFullName,
                text: "INSERT INTO " + this.#deploymentTableFullName + " VALUES($1,$2,$3);",
                values: [funcName, funcArgs, bodyHashCode]
            }
        );

        await dbClient.query("COMMIT;");


        this.#deploymentTable[funcName] = { "args": funcArgs, "bodyHashCode": bodyHashCode };

        console.debug("Meta table updated:\n %j", this.#deploymentTable);
    }


}

module.exports.Deployment = Deployment;
module.exports.DeploymentMode = DeploymentMode;