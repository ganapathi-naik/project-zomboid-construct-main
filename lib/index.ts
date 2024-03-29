import { CfnOutput, ITaggable, TagManager, Tags, Size, Stack } from "aws-cdk-lib";
import { Construct } from 'constructs';
import { Asset } from "aws-cdk-lib/aws-s3-assets";

import * as fs from "fs";
import * as path from "path";

import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import * as r53 from "aws-cdk-lib/aws-route53";

import * as logic from "./logic/server-config"
import { ZomboidAccess } from "./components/zomboid-access"

export const TEMPLATE_DIR = path.join(__dirname, "..", "assets", "templates")
export const DIST_DIR = path.join(process.cwd(), "assets", "dist")

// path.join(process.cwd(), "assets")
export interface GameServerProps {
  game: GameConfig,
  infra: InfraConfig,
}

export type InfraConfig = {
  region: string,
  vpc: ec2.IVpc,
  key: kms.IKey,
  role: iam.IRole,
  hz: r53.IHostedZone,
  instancetype?: string,
  keyPair?: string,

  // keyName: string;
  // subdomain?: string,
  // sg: ec2.ISecurityGroup,
  // vol: ec2.IVolume,
}

export type GameConfig = {
  servername?: string,
  fresh?: boolean,
  public?: Boolean;
  distdir: string,
  modFile?: Buffer,
}

// Ubuntu 20.04 LTS
const amimap: Record<string, string> = {
  "us-east-2": "ami-0c15a71461028f685",
  "us-east-1": "ami-0f5513ad02f8d23ed",
}

export class GameServerStack extends Construct implements ITaggable {

  public userData: ec2.MultipartUserData;
  public readonly tags: TagManager;

  constructor(scope: Construct, id: string, props: GameServerProps) {
    super(scope, id);

    // Ensure some values
    props.game.servername === undefined ? props.game.servername = "servertest" : null;
    props.game.fresh === undefined ? props.game.fresh = false : null;
    props.infra.instancetype === undefined ? props.infra.instancetype = "t2.micro" : null;

    // TODO::Think more about security groups
    let serverSG = new ec2.SecurityGroup(this, "sg-id", {
      vpc: props.infra.vpc,
    })

    // Select an image type

    // ssm steps for userdata
    // sudo snap switch --channel=candidate amazon-ssm-agent
    // sudo snap install amazon-ssm-agent --classic
    // 

    // TODO::Give role route53:ChangeResourceRecordSets on arn::HostedZoneId
    // props.infra.role.attachInlinePolicy(new iam.Policy(this, `${props.game.servername}-ebs-policy`, {
    //   statements: [new iam.PolicyStatement({
    //     actions: ['route53:ChangeResourceRecordSets'],
    //     resources: [props.infra.hz.hostedZoneArn],
    //   })],
    // }))

    this.userData = new ec2.MultipartUserData;
    const setupCommands = ec2.UserData.forLinux();
    setupCommands.addCommands(
      `echo "---- Install deps"`,
      `sudo add-apt-repository multiverse`,
      `sudo dpkg --add-architecture i386`,
      `sudo apt update`,
      `sudo apt install -y lib32gcc1 libsdl2-2.0-0:i386 docker.io awscli unzip`
    );

    // You must set true for the third argument `makeDefault` in order to use
    // the following multipart patterns
    this.userData.addUserDataPart(setupCommands, "", true);

    const machineImage = ec2.MachineImage.genericLinux(amimap);

    // ---- Build server
    const instance = new ec2.Instance(this, "project-zomboid-ec2", {
      instanceType: new ec2.InstanceType(props.infra.instancetype),
      machineImage: machineImage,
      vpc: props.infra.vpc,
      vpcSubnets: {
        subnetType: props.game.public === true || undefined ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_WITH_NAT,
      },
      keyName: props.infra.keyPair,
      securityGroup: serverSG,
      role: props.infra.role,
      // User data can only be mutated via its functions past this point
      userData: this.userData,
    });
    Tags.of(instance).add("Name", `${props.game.servername}`);
    Tags.of(instance).add("game", `pz-${props.game.servername}`);

    // See the docs on this method for more info:
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.Volume.html#grantwbrattachwbrvolumewbrbywbrresourcewbrtaggrantee-constructs-tagkeysuffix

    let vol = new ec2.Volume(this, `${props.game.servername}-vol`, {
      availabilityZone: 'us-east-2a',
      size: Size.gibibytes(20),
    });
    Tags.of(vol).add("game", `pz-${props.game.servername}-vol`);
    Tags.of(vol).add("Name", `pz-${props.game.servername}-vol`);

    vol.grantAttachVolumeByResourceTag(instance.grantPrincipal, [instance], "zomboid");

    // TODO::Probably would not work multiple mounted volumes
    const targetDevice = '/dev/xvdf';
    instance.userData.addCommands(
      // Retrieve token for accessing EC2 instance metadata (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html)
      `TOKEN=$(curl -SsfX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")`,
      // Retrieve the instance Id of the current EC2 instance
      `INSTANCE_ID=$(curl -SsfH "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)`,
      // Attach the volume to /dev/xvdz
      `aws --region ${Stack.of(this).region} ec2 attach-volume --volume-id ${vol.volumeId} --instance-id $INSTANCE_ID --device ${targetDevice}`,
      // Wait until the volume has attached
      `while ! test -e ${targetDevice}; do sleep 1; done`
      // The volume will now be mounted. You may have to add additional code to format the volume if it has not been prepared.
    );

    instance.userData.addCommands(
      `mkfs -t xfs /dev/xvdf`,
      `mkdir /mnt/${props.game.servername}`,
      `mount /dev/xvdf /mnt/${props.game.servername}`,
      `echo "UUID=$(lsblk -o +UUID | grep thepain | awk '{print $8}') /mnt/${props.game.servername}  xfs  defaults,nofail  0  2" >> /etc/fstab`,
    );


    // 
    // This builds the configs and writes to the dist dir
    // 
    logic.buildServerConfig(
      instance.userData,
      props.game
    );


    const serverConfigDir = new Asset(this, "pz-config-dir", {
      path: path.join(DIST_DIR, "server-config"),
    });
    serverConfigDir.grantRead(props.infra.role);

    const unitFileDir = new Asset(this, "pz-unit-dir", {
      path: path.join(DIST_DIR, "units"),
    });
    serverConfigDir.grantRead(props.infra.role);


    // Zip up config directory, I know this will zip because I am using the
    // folder as my `localFile`
    instance.userData.addS3DownloadCommand({
      bucket: serverConfigDir.bucket!,
      bucketKey: serverConfigDir.s3ObjectKey!,
      localFile: `/mnt/${props.game.servername}/files/`,
    });

    instance.userData.addS3DownloadCommand({
      bucket: unitFileDir.bucket!,
      bucketKey: unitFileDir.s3ObjectKey!,
      localFile: `/mnt/${props.game.servername}/files/`,
    });

    // Place, enable, and start the service
    instance.userData.addCommands(
      `mkdir -p /mnt/${props.game.servername}/Server/`, // Just in case
      `unzip /mnt/${props.game.servername}/files/${serverConfigDir.s3ObjectKey} -d /mnt/${props.game.servername}/Server/`,
      `unzip /mnt/${props.game.servername}/files/${unitFileDir.s3ObjectKey} -d /etc/systemd/system/`,
      `chmod +x /etc/systemd/system/${props.game.servername}.service`,
    );

    console.log(`${props.game.servername}_service.service`)

    // TODO fix up her'
    instance.userData.addCommands(
      `systemctl enable ${props.game.servername}_service.service`,
      `systemctl start ${props.game.servername}_service.service`,
      // `systemctl enable ebs-unit.service`,
      // `systemctl start ebs-unit.service`,
      // `systemctl enable r53-unit.service`,
      // `systemctl start r53-unit.service`,
    );

    // Holder for pz sg's
    // todo::nested?
    const zomboidServerSg = new ec2.SecurityGroup(
      this,
      "zomboid-server-port-reqs",
      {
        vpc: props.infra.vpc,
        allowAllOutbound: true,
        description: "sg to match zomboid requirements",
      }
    );

    // Following two sg's are for Steam server
    zomboidServerSg.addIngressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.tcpRange(27010, 27020),
      "steam tcp rules"
    );

    zomboidServerSg.addIngressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.udpRange(27010, 27020),
      "steam udp rules"
    );

    // Loop users out of context and provide access via sg
    // This is simplest possible design based on user IP so I don't have to 
    // have private subnets, NATs, or anything else that costs money this will
    // be resolved in the next update which will include an NLB, by default 
    // there are no users
    let users = this.node.tryGetContext('users')
    for (let key in users) {
      let value = users[key];
      new ZomboidAccess(this, "zomboid-users-" + value, {
        securityGroup: zomboidServerSg,
        playersIp: value,
        player: key
      })
    }

    // add the pz ingress rules
    instance.addSecurityGroup(zomboidServerSg);

    // If a subdomain is provided, create and use it
    // warning: will fail if trying to use twice
    let pzHz: r53.IPublicHostedZone;
    if (props.game.servername) {
      pzHz = new r53.PublicHostedZone(this, "HostedZoneDev", {
        zoneName: props.game.servername + "." + props.infra.hz.zoneName,
      });
      // todo::This can probably be a downstream lookup
      new r53.NsRecord(this, "NsForParentDomain", {
        zone: props.infra.hz,
        recordName: pzHz.zoneName,
        values: pzHz.hostedZoneNameServers!, // exclamation is like, hey it might be null but no: https://stackoverflow.com/questions/54496398/typescript-type-string-undefined-is-not-assignable-to-type-string
      });
    } else {
      pzHz = props.infra.hz;
    }

    new r53.ARecord(this, `PzARecordB-${props.game.servername}`, {
      zone: pzHz!,
      // ERROR here
      target: r53.RecordTarget.fromIpAddresses(instance.instancePublicIp),
    });


    console.log(this.userData);

    // Create outputs for connecting
    new CfnOutput(this, `IPAddress-${props.game.servername}`, {
      value: instance.instancePublicIp,
      exportName: `${props.game.servername}-IP-Address`
    });
  }
}
