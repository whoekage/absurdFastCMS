CREATE TABLE "articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(512),
	"body" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"views" integer,
	"rating" double precision,
	"active" boolean NOT NULL,
	"published_at" timestamp with time zone NOT NULL
);
